// ============================================================
// tests/unit/cli/handlers/auto-handler-guard.test.ts — Sprint D-1b §16.5 RED
// ------------------------------------------------------------
// 覆盖: T25 (per ADR-0016 §16.5 D-1b)
//   T25: runDailyLoop + guard.onBlock 触发 (3 路径):
//     - 失败率 > threshold → guard.onBlock('high_failure_rate', null)
//     - sendGreeting 抛 GuardError('anti_bot') → guard.onBlock('anti_bot', error)
//   验证: accountMetaStore.recordBlock 被调 + stats.guardTriggers += 1
//         + notifier critical + stats.blocked=true + exitCode=2
// 纪律: §3.13 错误分层 (notifier msg 前缀 [AUTO.guard])
//       §3.12 mock 注入 (in-memory accountMetaStore)
//       §3.10 refactor: deps 加 3 可选字段 → 现有 6 it() (T14-T16) 不破
// 单账号红线守住: guard.onBlock 是注入 deps, 默认不触碰 BOSS
// ============================================================

import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  runDailyLoop,
  type AutoHandlerDeps,
} from '../../../../src/cli/handlers/auto-handler'
import type { AutoConfig, AccountMeta, Job } from '../../../../src/auto/throttle'
import { createInMemoryCounterStore } from '../../../../src/auto/counter-store'
import { GuardError } from '../../../../src/auto/guard'

// ─── 共享 fake clock + seeded RNG (per §3.12) ────────────────

let _now = new Date('2026-07-28T09:10:00').getTime()
const now = () => _now
const setClock = (ms: number) => { _now = ms }

let _rngState = 0
const seedRandom = (seed: number) => { _rngState = seed >>> 0 }
const rand = (): number => {
  _rngState = (_rngState + 0x6D2B79F5) | 0
  let t = _rngState
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

const noopSleep = async () => {}

beforeEach(() => {
  setClock(new Date('2026-07-28T09:10:00').getTime())
  seedRandom(0)
})

// ─── 默认 fixtures ────────────────────────────────────────────

const warmupSchedule = [
  { dayStart: 1, cap: 50 },
  { dayStart: 8, cap: 70 },
  { dayStart: 15, cap: 100 },
]

/** D-1b: AccountMeta 加 currentTier + blockedHistory (per §16.3.3 关系图) */
const baseMeta: AccountMeta = {
  registeredAt: Date.now() - 15 * 86_400_000,
  accountAgeDays: 15,
  baseDailyCap: 30,
  targetDailyCap: 100,
  weeklyCap: 500,
  warmupSchedule,
  currentTier: 'old',
  blockedHistory: [],
}

const baseConfig: AutoConfig = {
  dryRun: false,
  phase: 'morning',
  quota: { morning: 5, afternoon: 5, weekly_cap: 50 },
  throttle: {
    morning_interval_ms: [0, 1],
    afternoon_interval_ms: [0, 1],
    jitter_pct: 0,
    long_pause: { every_n_jobs: 100, duration_ms: [0, 1] },
    afternoon_mid_break: { after_job: 100, duration_ms: [0, 1] },
  },
}

// ─── 内存 accountMetaStore (D-1b 新, 模拟 createFsAccountMetaStore) ─

interface RecordBlockCall { reason: string; error: Error | null }
interface RegressWarmupCall { /* no args */ }

const makeInMemoryAccountMetaStore = (initial: AccountMeta = { ...baseMeta }) => {
  let state: AccountMeta = { ...initial, blockedHistory: [...initial.blockedHistory] }
  const recordBlockCalls: RecordBlockCall[] = []
  const regressWarmupCalls: RegressWarmupCall[] = []

  return {
    store: {
      async load(): Promise<AccountMeta> {
        return { ...state, blockedHistory: [...state.blockedHistory] }
      },
      async save(meta: AccountMeta): Promise<void> {
        state = { ...meta, blockedHistory: [...meta.blockedHistory] }
      },
      async recordBlock(reason: string, error: Error | null): Promise<AccountMeta> {
        recordBlockCalls.push({ reason, error })
        const updated: AccountMeta = {
          ...state,
          blockedHistory: [
            ...state.blockedHistory,
            { ts: Date.now(), reason },
          ],
          currentTier: state.currentTier, // 默认不降档, 由 regressWarmup 触发
        }
        state = updated
        return updated
      },
      async regressWarmup(): Promise<AccountMeta> {
        regressWarmupCalls.push({})
        // 模拟降档: old → warm → new
        const tierOrder = ['new', 'warm', 'old'] as const
        const idx = tierOrder.indexOf(state.currentTier)
        const newTier = idx > 0 ? tierOrder[idx - 1] : state.currentTier
        const updated = { ...state, currentTier: newTier }
        state = updated
        return updated
      },
    },
    recordBlockCalls,
    regressWarmupCalls,
    getState: () => state,
    reset: () => {
      state = { ...initial, blockedHistory: [...initial.blockedHistory] }
      recordBlockCalls.length = 0
      regressWarmupCalls.length = 0
    },
  }
}

// ─── D-1b makeDeps (扩展: 加 guard + accountMetaStore + strictExitCode) ─

interface NotifyCall { level: 'warn' | 'critical'; msg: string }
interface CallCounter { count: number }

const makeDeps = (overrides: Partial<AutoHandlerDeps> = {}): {
  deps: AutoHandlerDeps
  notifyCalls: NotifyCall[]
  guardCalls: Array<{ reason: string; error: Error | null }>
  accountMeta: ReturnType<typeof makeInMemoryAccountMetaStore>
} => {
  const notifyCalls: NotifyCall[] = []
  const guardCalls: Array<{ reason: string; error: Error | null }> = []
  const accountMeta = makeInMemoryAccountMetaStore()
  const loginCalls: CallCounter = { count: 0 }

  const deps: AutoHandlerDeps = {
    now,
    rand,
    bossSearch: async () => Array.from({ length: 10 }, (_, i) => ({ id: `j${i + 1}` })),
    counterStore: createInMemoryCounterStore(),
    sendGreeting: async () => { /* default ok */ },
    loginByQR: async () => { loginCalls.count += 1 },
    notifier: {
      notify: async (level, msg) => { notifyCalls.push({ level, msg }) },
    },
    accountMeta: baseMeta,
    config: baseConfig,
    sleep: noopSleep,
    // D-1b 新字段 (可选, 测试显式注入):
    accountMetaStore: accountMeta.store,
    guard: {
      onBlock: async (reason, error) => {
        guardCalls.push({ reason, error })
        await accountMeta.store.recordBlock(reason, error)
        await deps.notifier.notify(
          'critical',
          `[AUTO.guard] ${reason}: ${error?.message ?? ''}`,
        )
      },
    },
    strictExitCode: false,
    ...overrides,
  }

  return { deps, notifyCalls, guardCalls, accountMeta }
}

// ─── T25: guard.onBlock 触发 → recordBlock + notifier critical ──

describe('T25: guard.onBlock 触发 (D-1b 缺口 1+4)', () => {
  it('T25a: 失败率 > 30% → guard.onBlock("high_failure_rate") + recordBlock + exit 2', async () => {
    const tenJobs: Job[] = Array.from({ length: 10 }, (_, i) => ({ id: `j${i + 1}` }))
    const m = makeDeps({
      bossSearch: async () => tenJobs,
      sendGreeting: async (job) => {
        const idNum = parseInt(job.id.replace('j', ''), 10)
        if (idNum <= 4) throw new Error('BOSS 拒收')  // 4/10 = 40% > 30%
      },
    })
    const result = await runDailyLoop(m.deps, '2026-07-28')

    // 1. guard.onBlock 被调用 1 次, reason='high_failure_rate', error=null
    expect(m.guardCalls.length).toBe(1)
    expect(m.guardCalls[0]?.reason).toBe('high_failure_rate')
    expect(m.guardCalls[0]?.error).toBeNull()

    // 2. accountMetaStore.recordBlock 被调用 1 次
    expect(m.accountMeta.recordBlockCalls.length).toBe(1)
    expect(m.accountMeta.recordBlockCalls[0]?.reason).toBe('high_failure_rate')

    // 3. accountMeta.blockedHistory 持久化 +1 条
    expect(m.accountMeta.getState().blockedHistory.length).toBe(1)

    // 4. notifier critical 被调 (至少 1 次 = guard.onBlock 内部)
    const critical = m.notifyCalls.filter(c => c.level === 'critical')
    expect(critical.length).toBeGreaterThanOrEqual(1)
    expect(critical.some(c => c.msg.includes('[AUTO.guard]'))).toBe(true)

    // 5. stats.blocked + guardTriggers + exit 3 (D-3 §17.12 修正 3: 风控 = exit 3, 区别 fatal 2)
    expect(result.stats.blocked).toBe(true)
    expect(result.stats.guardTriggers).toBe(1)
    expect(result.exitCode).toBe(3)
    expect(result.state).toBe('blocked')
  })

  it('T25b: sendGreeting 抛 GuardError("anti_bot") → guard.onBlock("anti_bot") + recordBlock + exit 2', async () => {
    const threeJobs: Job[] = [{ id: 'j1' }, { id: 'j2' }, { id: 'j3' }]
    const m = makeDeps({
      bossSearch: async () => threeJobs,
      sendGreeting: async (job) => {
        if (job.id === 'j2') {
          throw new GuardError('环境异常, 请扫码', 'anti_bot')
        }
      },
    })
    const result = await runDailyLoop(m.deps, '2026-07-28')

    // 1. guard.onBlock 被调用 1 次, reason='anti_bot', error 是 GuardError
    expect(m.guardCalls.length).toBe(1)
    expect(m.guardCalls[0]?.reason).toBe('anti_bot')
    expect(m.guardCalls[0]?.error).toBeInstanceOf(GuardError)
    expect((m.guardCalls[0]?.error as GuardError)?.reason).toBe('anti_bot')

    // 2. recordBlock 被调
    expect(m.accountMeta.recordBlockCalls.length).toBe(1)
    expect(m.accountMeta.recordBlockCalls[0]?.reason).toBe('anti_bot')

    // 3. blockedHistory 持久化
    expect(m.accountMeta.getState().blockedHistory.length).toBe(1)

    // 4. notifier critical (含 [AUTO.guard] 前缀)
    const critical = m.notifyCalls.filter(c => c.level === 'critical')
    expect(critical.length).toBeGreaterThanOrEqual(1)
    expect(critical[0]?.msg).toContain('[AUTO.guard]')
    expect(critical[0]?.msg).toContain('anti_bot')

    // 5. stats.blocked + guardTriggers + exit 3 + state=blocked (D-3 §17.12 修正 3)
    expect(result.stats.blocked).toBe(true)
    expect(result.stats.guardTriggers).toBe(1)
    expect(result.exitCode).toBe(3)
    expect(result.state).toBe('blocked')

    // 6. send 在 j2 后停止 (j3 未投)
    expect(result.stats.sent).toBe(1)  // j1 ok, j2 触发 guard, break
  })

  it('T25c: deps 未注入 guard → 向后兼容 (Sprint C-2a 行为: 直接 notifier + break, 0 改)', async () => {
    // 验证: D-1b 加的 guard 字段是 optional, 不传 = 走原 R3 路径 (notifier + break, 不调 recordBlock)
    const tenJobs: Job[] = Array.from({ length: 10 }, (_, i) => ({ id: `j${i + 1}` }))
    const m = makeDeps({
      bossSearch: async () => tenJobs,
      sendGreeting: async (job) => {
        const idNum = parseInt(job.id.replace('j', ''), 10)
        if (idNum <= 4) throw new Error('BOSS 拒收')  // 4/10 > 30%
      },
    })
    // 删除 guard 字段, 模拟旧 caller
    const { guard: _dropped, ...depsWithoutGuard } = m.deps  // eslint-disable-line @typescript-eslint/no-unused-vars
    const result = await runDailyLoop(depsWithoutGuard, '2026-07-28')

    // 1. guardCalls 为空 (未注入)
    expect(m.guardCalls.length).toBe(0)

    // 2. recordBlock 未被调
    expect(m.accountMeta.recordBlockCalls.length).toBe(0)

    // 3. blockedHistory 未变
    expect(m.accountMeta.getState().blockedHistory.length).toBe(0)

    // 4. stats.blocked + exit 3 (R3 行为不变, 但 D-3 §17.12 修正 3: exit 3 区分 fatal 2)
    expect(result.stats.blocked).toBe(true)
    expect(result.exitCode).toBe(3)
    expect(result.state).toBe('blocked')

    // 5. notifier critical 仍被调 (旧的 [AUTO.runner] 前缀)
    const critical = m.notifyCalls.filter(c => c.level === 'critical')
    expect(critical.length).toBeGreaterThanOrEqual(1)
    expect(critical[0]?.msg).toContain('[AUTO.runner]')
  })
})

// ─── T26: strictExitCode=true + effective=0 → exit 2 (D-1b 缺口 6 P1) ──

describe('T26: strictExitCode 严格退出码 (D-1b 缺口 6 P1)', () => {
  it('T26a: strictExitCode=true + 3 jobs 全失败 → exit 2 (致命软错误, effective=0 但 sent>0)', async () => {
    const threeJobs: Job[] = [{ id: 'j1' }, { id: 'j2' }, { id: 'j3' }]
    const m = makeDeps({
      bossSearch: async () => threeJobs,
      sendGreeting: async () => { throw new Error('BOSS 拒收') },
      strictExitCode: true,
    })
    const result = await runDailyLoop(m.deps, '2026-07-28')

    // 关键 (缺口 6): 全 reject 但 counter 走完, strictExitCode 开启时视为致命软错误
    expect(result.stats.sent).toBe(3)
    expect(result.stats.failed).toBe(3)
    expect(result.stats.effective_successes).toBe(0)
    expect(result.stats.blocked).toBe(false)  // 不是 R3 blocked
    expect(result.exitCode).toBe(2)  // strict 模式 → 致命软错误
    expect(result.state).toBe('done')
  })

  it('T26b: strictExitCode=false + 3 jobs 全失败 → exit 1 (Sprint C-2a 行为不变)', async () => {
    const threeJobs: Job[] = [{ id: 'j1' }, { id: 'j2' }, { id: 'j3' }]
    const m = makeDeps({
      bossSearch: async () => threeJobs,
      sendGreeting: async () => { throw new Error('BOSS 拒收') },
      strictExitCode: false,
    })
    const result = await runDailyLoop(m.deps, '2026-07-28')

    expect(result.stats.effective_successes).toBe(0)
    expect(result.exitCode).toBe(1)  // 默认 = 普通失败
    expect(result.state).toBe('done')
  })

  it('T26c: strictExitCode=true + 1 ok + 2 fail → exit 0 (effective>0 不变)', async () => {
    const threeJobs: Job[] = [{ id: 'j1' }, { id: 'j2' }, { id: 'j3' }]
    const m = makeDeps({
      bossSearch: async () => threeJobs,
      sendGreeting: async (job) => {
        if (job.id === 'j2' || job.id === 'j3') throw new Error('BOSS 拒收')
      },
      strictExitCode: true,
    })
    const result = await runDailyLoop(m.deps, '2026-07-28')

    expect(result.stats.effective_successes).toBe(1)
    expect(result.exitCode).toBe(0)  // ≥1 ok 不变
  })
})

// ─── T27: R2 GuardError + guard 未注入 → 向后兼容 (P1) ────────

describe('T27: R2 GuardError + guard 未注入 → 向后兼容 (P1)', () => {
  it('T27a: deps.guard 未注入 + sendGreeting 抛 GuardError → 旧 R2 路径 (notifier + break, 不调 recordBlock)', async () => {
    const threeJobs: Job[] = [{ id: 'j1' }, { id: 'j2' }, { id: 'j3' }]
    const m = makeDeps({
      bossSearch: async () => threeJobs,
      sendGreeting: async (job) => {
        if (job.id === 'j2') throw new GuardError('环境异常', 'anti_bot')
      },
    })
    // 删除 guard 字段, 模拟旧 caller
    const { guard: _dropped, ...depsWithoutGuard } = m.deps
    const result = await runDailyLoop(depsWithoutGuard, '2026-07-28')

    // 1. guardCalls 空 (未注入)
    expect(m.guardCalls.length).toBe(0)

    // 2. recordBlock 未调 (旧的 notifier 路径)
    expect(m.accountMeta.recordBlockCalls.length).toBe(0)

    // 3. blockedHistory 未变
    expect(m.accountMeta.getState().blockedHistory.length).toBe(0)

    // 4. stats.blocked + guardTriggers
    expect(result.stats.blocked).toBe(true)
    expect(result.stats.guardTriggers).toBe(1)

    // 5. exit 3 (R2 风控, D-3 §17.12 修正 3 区分 fatal 2)
    expect(result.exitCode).toBe(3)
    expect(result.state).toBe('blocked')

    // 6. notifier critical 仍调 (旧的 [AUTO.runner] 前缀, 含 reason)
    const critical = m.notifyCalls.filter(c => c.level === 'critical')
    expect(critical.length).toBeGreaterThanOrEqual(1)
    expect(critical[0]?.msg).toContain('[AUTO.runner]')
    expect(critical[0]?.msg).toContain('anti_bot')
  })
})

// ─── T28: defaultSleep fallback (P1) ─────────────────────────

describe('T28: defaultSleep fallback (P1)', () => {
  it('T28a: deps.sleep 未注入 + sendGreeting OK → runDailyLoop 不抛 (defaultSleep 自然回落)', async () => {
    // 验证: deps.sleep undefined 时 defaultSleep 被使用, throttleSend 内部 sleepMs=0 不实际等待
    const m = makeDeps({
      bossSearch: async () => [{ id: 'j1' }],
      sendGreeting: async () => { /* ok */ },
      // sleep 不注入
    })
    // 删除 sleep 字段
    const { sleep: _dropped, ...depsWithoutSleep } = m.deps
    const result = await runDailyLoop(depsWithoutSleep, '2026-07-28')

    // 不抛 + exit 0
    expect(result.exitCode).toBe(0)
    expect(result.stats.ok).toBe(1)
  })
})