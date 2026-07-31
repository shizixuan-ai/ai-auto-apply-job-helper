// ============================================================
// tests/unit/cli/handlers/auto-handler.test.ts — Sprint C-2a §14.5 RED
// ------------------------------------------------------------
// 覆盖: T14-T16 (per ADR-0016 §14.5 C-2a + R1 + R3 + R6)
// 纪律: §3.13 错误分层 (notifier layer='AUTO.runner');
//       §3.12 mock 注入 (fake clock + noop sleep + stub deps)
//       §3.10 refactor: throttle.ts 测试 caller 不影响 (mock 工厂保持兼容)
// ============================================================

import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  runDailyLoop,
  type AutoHandlerDeps,
  type RunResult,
} from '../../../../src/cli/handlers/auto-handler'
import type { AutoConfig, AccountMeta, Job } from '../../../../src/auto/throttle'
import { createInMemoryCounterStore } from '../../../../src/auto/counter-store'

// ─── 共享 fake clock + seeded RNG + noop sleep (per §3.12) ────

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

const metaDay15: AccountMeta = {
  registeredAt: Date.now() - 15 * 86_400_000,
  accountAgeDays: 15,
  baseDailyCap: 30,
  targetDailyCap: 100,
  weeklyCap: 500,
  warmupSchedule,
}

// 测试用紧凑配置 (per §3.12 加速测试): interval=0-1ms, cap=5
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

const jobs: Job[] = Array.from({ length: 10 }, (_, i) => ({ id: `job-${i + 1}` }))

interface NotifyCall { level: 'warn' | 'critical'; msg: string }
interface CallCounter { count: number }

const makeDeps = (overrides: Partial<AutoHandlerDeps> = {}): {
  deps: AutoHandlerDeps
  notifyCalls: NotifyCall[]
  sendCalls: string[]
  loginCalls: CallCounter
  searchCalls: string[]
} => {
  const notifyCalls: NotifyCall[] = []
  const sendCalls: string[] = []
  // 用 object 而非 number, 保证 closure 内的 increment 在外部可见 (per §3.12 mock 注入纪律)
  const loginCalls: CallCounter = { count: 0 }
  const searchCalls: string[] = []

  const deps: AutoHandlerDeps = {
    now,
    rand,
    bossSearch: async (date) => { searchCalls.push(date); return jobs },
    counterStore: createInMemoryCounterStore(),
    sendGreeting: async (job) => { sendCalls.push(job.id) },
    loginByQR: async () => { loginCalls.count += 1 },
    notifier: {
      notify: async (level, msg) => { notifyCalls.push({ level, msg }) },
    },
    accountMeta: metaDay15,
    config: baseConfig,
    sleep: noopSleep,
    ...overrides,
  }

  return { deps, notifyCalls, sendCalls, loginCalls, searchCalls }
}

// ─── T14: initial login (R1) ─────────────────────────────────

describe('T14: 初始 loginByQR', () => {
  it('T14a: loginByQR 成功 → 进 running + bossSearch 调用', async () => {
    const m = makeDeps()
    const result = await runDailyLoop(m.deps, '2026-07-28')

    expect(m.loginCalls.count).toBe(1)  // loginByQR 调用 1 次
    expect(m.searchCalls).toEqual(['2026-07-28'])  // bossSearch 调用 1 次
    expect(m.sendCalls.length).toBeGreaterThan(0)  // sendGreeting 被调用
    expect(result.exitCode).toBe(0)  // ≥1 ok → exit 0
    expect(result.state).toBe('done')
    expect(result.stats.blocked).toBe(false)
  })

  it('T14b: loginByQR 失败 → exit 2 + state=aborted + notifier critical', async () => {
    const m = makeDeps({
      loginByQR: async () => { m.loginCalls.count += 1; throw new Error('QR 已过期') },
    })
    const result = await runDailyLoop(m.deps, '2026-07-28')

    expect(m.loginCalls.count).toBe(1)  // loginByQR 尝试 1 次后失败
    expect(m.searchCalls).toEqual([])  // bossSearch 未调用 (login 失败跳过)
    expect(m.sendCalls).toEqual([])  // sendGreeting 未调用
    expect(result.exitCode).toBe(2)
    expect(result.state).toBe('aborted')
    expect(result.stats.sent).toBe(0)  // 配额未消耗
    // notifier critical 通知
    const critical = m.notifyCalls.filter(c => c.level === 'critical')
    expect(critical.length).toBeGreaterThanOrEqual(1)
    expect(critical[0].msg).toMatch(/login/)
  })
})

// ─── T15: 单 job 失败 continue (B2=a) ───────────────────────

describe('T15: 单 job 投递失败 continue 下一 job', () => {
  it('T15a: 3 jobs (1 ok + 2 fail) → stats.sent=3, stats.ok=1, stats.failed=2, exit 0 (≥1 ok)', async () => {
    // 用 3 jobs 而非 10, 避免触发失败率阈值检查
    const threeJobs: Job[] = [{ id: 'j1' }, { id: 'j2' }, { id: 'j3' }]
    const m = makeDeps({
      bossSearch: async () => threeJobs,
      sendGreeting: vi.fn(async (job) => {
        if (job.id === 'j2' || job.id === 'j3') throw new Error('BOSS 拒收')
        // j1 ok
      }),
    })
    const result = await runDailyLoop(m.deps, '2026-07-28')

    expect(result.stats.sent).toBe(3)
    expect(result.stats.ok).toBe(1)
    expect(result.stats.failed).toBe(2)
    expect(result.stats.blocked).toBe(false)
    expect(result.exitCode).toBe(0)  // ≥1 ok
    expect(result.state).toBe('done')
  })

  it('T15b: 全部 3 jobs 失败 → exit 1 (无 ok) + continue 跑完所有', async () => {
    const threeJobs: Job[] = [{ id: 'j1' }, { id: 'j2' }, { id: 'j3' }]
    const m = makeDeps({
      bossSearch: async () => threeJobs,
      sendGreeting: async () => { throw new Error('BOSS 拒收') },
    })
    const result = await runDailyLoop(m.deps, '2026-07-28')

    expect(result.stats.sent).toBe(3)
    expect(result.stats.ok).toBe(0)
    expect(result.stats.failed).toBe(3)
    expect(result.stats.blocked).toBe(false)  // jobs < 10, 未触发失败率
    expect(result.exitCode).toBe(1)  // 全失败
    expect(result.state).toBe('done')
  })
})

// ─── T16: 失败率 > 30% → blocked + exit 2 (R3) ──────────────

describe('T16: 失败率超阈 → blocked + exit 2', () => {
  it('T16a: 10 jobs (6 ok + 4 fail = 40% failed) → blocked + exit 2', async () => {
    const tenJobs: Job[] = Array.from({ length: 10 }, (_, i) => ({ id: `j${i + 1}` }))
    const m = makeDeps({
      bossSearch: async () => tenJobs,
      sendGreeting: async (job) => {
        // j1-j4 失败, j5-j10 ok → 4/10 = 40% > 30%
        const idNum = parseInt(job.id.replace('j', ''), 10)
        if (idNum <= 4) throw new Error('BOSS 拒收')
      },
    })
    const result = await runDailyLoop(m.deps, '2026-07-28')

    expect(result.stats.sent).toBeGreaterThanOrEqual(10)
    expect(result.stats.failed).toBeGreaterThanOrEqual(4)
    expect(result.stats.ok).toBeGreaterThanOrEqual(6)
    expect(result.stats.blocked).toBe(true)
    expect(result.exitCode).toBe(3)  // D-3 §17.12 修正 3: 风控 = exit 3 (区别 fatal 2)
    expect(result.state).toBe('blocked')

    // notifier critical 应被调用 (per §14.2.4 流程图)
    const critical = m.notifyCalls.filter(c => c.level === 'critical')
    expect(critical.length).toBeGreaterThanOrEqual(1)
    expect(critical[0].msg).toMatch(/failure.*rate|失败率/)
  })

  it('T16b: 失败率恰好 30% (临界值) → 不触发 blocked (严格大于)', async () => {
    const thirtyJobs: Job[] = Array.from({ length: 10 }, (_, i) => ({ id: `j${i + 1}` }))
    const m = makeDeps({
      bossSearch: async () => thirtyJobs,
      sendGreeting: async (job) => {
        const idNum = parseInt(job.id.replace('j', ''), 10)
        // 3/10 = 30% 失败 (临界值, 严格 > 0.3 不触发)
        if (idNum <= 3) throw new Error('BOSS 拒收')
      },
    })
    const result = await runDailyLoop(m.deps, '2026-07-28')

    expect(result.stats.failed).toBe(3)
    expect(result.stats.sent).toBe(10)
    expect(result.stats.blocked).toBe(false)  // 严格 > 0.3, 30% 不触发
    expect(result.exitCode).toBe(0)  // 7 ok ≥ 1
  })
})