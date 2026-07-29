// ============================================================
// tests/unit/cli/handlers/build-default-deps.test.ts — Sprint D-2 §16.5 RED
// ------------------------------------------------------------
// 覆盖: T26-T28 (per ADR-0016 §16.5 D-2)
//   T26: buildDefaultDeps 返回 deps 结构齐全 (counterStore/accountMetaStore/
//        guard/notifier + 3 STUB)
//   T27: guard.onBlock('high_failure_rate') → recordBlock +
//        consecutiveBlocks >= 3 时 regressWarmup + notifier critical
//   T28: deps.bossSearch/sendGreeting/loginByQR 默认 STUB_THROW
//        (单账号红线: D-2 不允许触碰 BOSS, 抛 stub error 让 runDailyLoop 退 2)
// 纪律: §3.13 错误分层 (stub error message 含 layer 前缀);
//       §3.12 mock 注入 (configDir 注入, 测试用 in-memory factory);
//       §3.10 refactor: buildDefaultDeps 是新 export, 现有 caller 0 改
// 单账号红线守住: bossSearch/sendGreeting/loginByQR 全部抛 stub error,
//                  默认测试用 in-memory counter/accountMeta store
// ============================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import {
  buildDefaultDeps,
  type BuildDefaultDepsOpts,
} from '../../../../src/cli/handlers/auto-handler'
import type { AutoConfig, AccountMeta } from '../../../../src/auto/throttle'
import {
  createInMemoryCounterStore,
} from '../../../../src/auto/counter-store'
import {
  createInMemoryAccountMetaStore,
  type AccountMetaStore,
} from '../../../../src/auto/account-meta-store'
import { DEFAULT_SAFETY } from '../../../../src/auto/config-schema'

// ─── 共享 fixtures (per §3.12) ───────────────────────────────

let tmpDirs: string[] = []

const makeTmpDir = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(tmpdir(), 'build-default-deps-'))
  tmpDirs.push(dir)
  return dir
}

afterEach(async () => {
  for (const dir of tmpDirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => { /* best-effort */ })
  }
  tmpDirs = []
})

const baseConfig: AutoConfig = {
  dryRun: false,
  phase: 'morning',
  quota: { morning: 40, afternoon: 60, weekly_cap: 500 },
  throttle: {
    morning_interval_ms: [180000, 240000],
    afternoon_interval_ms: [150000, 195000],
    jitter_pct: 20,
    long_pause: { every_n_jobs: 20, duration_ms: [300000, 600000] },
    afternoon_mid_break: { after_job: 30, duration_ms: [600000, 900000] },
  },
}

const baseMeta: AccountMeta = {
  registeredAt: Date.now() - 15 * 86_400_000,
  accountAgeDays: 15,
  baseDailyCap: 30,
  targetDailyCap: 100,
  weeklyCap: 500,
  warmupSchedule: [
    { dayStart: 1, cap: 50 },
    { dayStart: 8, cap: 70 },
    { dayStart: 15, cap: 100 },
  ],
  currentTier: 'old',
  blockedHistory: [],
}

const baseOpts = (overrides: Partial<BuildDefaultDepsOpts> = {}): BuildDefaultDepsOpts => ({
  configDir: '/tmp/test-bapply',
  config: baseConfig,
  accountMeta: baseMeta,
  ...overrides,
})

// ─── T26: buildDefaultDeps 返回 deps 结构齐全 ────────────────

describe('T26: buildDefaultDeps 返回 deps 结构 (D-2a)', () => {
  it('T26a: 必填字段齐全 (counterStore/accountMetaStore/guard/notifier + config/accountMeta + 3 stub)', async () => {
    const deps = await buildDefaultDeps(baseOpts())

    // fs store 注入
    expect(deps.counterStore).toBeDefined()
    expect(deps.counterStore.load).toBeInstanceOf(Function)
    expect(deps.counterStore.writeAtomic).toBeInstanceOf(Function)

    // accountMetaStore 注入
    expect(deps.accountMetaStore).toBeDefined()
    expect(deps.accountMetaStore?.load).toBeInstanceOf(Function)
    expect(deps.accountMetaStore?.recordBlock).toBeInstanceOf(Function)

    // guard.onBlock 注入
    expect(deps.guard).toBeDefined()
    expect(deps.guard?.onBlock).toBeInstanceOf(Function)

    // notifier 注入 (默认 console)
    expect(deps.notifier).toBeDefined()
    expect(deps.notifier.notify).toBeInstanceOf(Function)

    // config + accountMeta 透传
    expect(deps.config).toBe(baseConfig)
    expect(deps.accountMeta).toBe(baseMeta)

    // 3 STUB (bossSearch/sendGreeting/loginByQR 是函数)
    expect(deps.bossSearch).toBeInstanceOf(Function)
    expect(deps.sendGreeting).toBeInstanceOf(Function)
    expect(deps.loginByQR).toBeInstanceOf(Function)
  })

  it('T26b: 自定义 counterStoreFactory + accountMetaStoreFactory 注入时被采用', async () => {
    const customCounter = createInMemoryCounterStore()
    const customAccountMeta = createInMemoryAccountMetaStore()

    const deps = await buildDefaultDeps(baseOpts({
      counterStoreFactory: () => customCounter,
      accountMetaStoreFactory: () => customAccountMeta,
    }))

    expect(deps.counterStore).toBe(customCounter)
    expect(deps.accountMetaStore).toBe(customAccountMeta)
  })

  it('T26c: 自定义 notifier 注入时被采用 (默认 console 不被覆盖)', async () => {
    const notifyCalls: Array<{ level: string; msg: string }> = []
    const customNotifier = {
      notify: async (level: 'warn' | 'critical', msg: string) => {
        notifyCalls.push({ level, msg })
      },
    }

    const deps = await buildDefaultDeps(baseOpts({ notifier: customNotifier }))

    expect(deps.notifier).toBe(customNotifier)

    // 验证 notifier 真被调 (通过 guard.onBlock 触发)
    await deps.guard!.onBlock('test_reason', null)
    expect(notifyCalls.length).toBe(1)
    expect(notifyCalls[0]?.msg).toContain('[AUTO.guard]')
  })
})

// ─── T27: guard.onBlock 触发 recordBlock + regressWarmup ───────

describe('T27: guard.onBlock 触发 recordBlock + 连续 blocked 降档 (D-2a)', () => {
  it('T27a: onBlock("anti_bot") → accountMetaStore.recordBlock + blockedHistory += 1 + notifier critical', async () => {
    const accountMetaStore = createInMemoryAccountMetaStore()
    const deps = await buildDefaultDeps(baseOpts({
      accountMetaStoreFactory: () => accountMetaStore,
    }))

    // 调 onBlock
    await deps.guard!.onBlock('anti_bot', null)

    // 1. recordBlock 被调
    const state = await accountMetaStore.load()
    expect(state.blockedHistory?.length).toBe(1)
    expect(state.blockedHistory?.[0]?.reason).toBe('anti_bot')

    // 2. notifier critical 被调 (默认 console 不 capture, 这里只验证 recordBlock 副作用)
  })

  it('T27b: 连续 blocked 3 次 (consecutive_guard_threshold=3) → regressWarmup 触发 + currentTier 降档', async () => {
    // 注入连续 blockedHistory 长度 = 2 (再触发 1 次 = 3 → 阈值)
    const initial: AccountMeta = {
      ...baseMeta,
      currentTier: 'old',
      blockedHistory: [
        { ts: Date.now() - 3000, reason: 'anti_bot' },
        { ts: Date.now() - 2000, reason: 'rate_limit' },
      ],
    }
    const accountMetaStore = createInMemoryAccountMetaStore(initial)
    const deps = await buildDefaultDeps(baseOpts({
      accountMetaStoreFactory: () => accountMetaStore,
    }))

    // 调 onBlock 第 3 次 → 应触发 regressWarmup (consecutiveBlocks >= threshold)
    await deps.guard!.onBlock('high_failure_rate', null)

    // 1. blockedHistory += 1 (现在 3 条)
    const state = await accountMetaStore.load()
    expect(state.blockedHistory?.length).toBe(3)
    expect(state.blockedHistory?.[2]?.reason).toBe('high_failure_rate')

    // 2. currentTier 降档 (old → warm)
    expect(state.currentTier).toBe('warm')
  })

  it('T27c: blockedHistory 长度 < threshold → 不降档 (currentTier 保持)', async () => {
    const initial: AccountMeta = {
      ...baseMeta,
      currentTier: 'warm',
      blockedHistory: [
        { ts: Date.now() - 1000, reason: 'anti_bot' },
      ],
    }
    const accountMetaStore = createInMemoryAccountMetaStore(initial)
    const deps = await buildDefaultDeps(baseOpts({
      accountMetaStoreFactory: () => accountMetaStore,
    }))

    await deps.guard!.onBlock('anti_bot', null)

    const state = await accountMetaStore.load()
    expect(state.currentTier).toBe('warm')  // 不变 (只有 2 条, threshold=3)
  })
})

// ─── T28: 3 STUB (bossSearch/sendGreeting/loginByQR 单账号红线) ─

describe('T28: 3 STUB 抛 stub error (单账号红线, D-2 不允许触碰 BOSS)', () => {
  it('T28a: deps.bossSearch() → throw StubError 含 layer="BOSS" + reason 说明', async () => {
    const deps = await buildDefaultDeps(baseOpts())

    try {
      await deps.bossSearch('2026-07-29')
      expect.fail('应该抛 StubError')
    } catch (e) {
      // 大小写不敏感 (实际 message 含 "stub" 小写)
      expect((e as Error).message).toMatch(/stub/i)
      expect((e as Error).message).toContain('bossSearch')
      // 单账号红线: 提醒 caller 不要传真 BOSS 实现
      expect((e as Error).message).toMatch(/not wired|not implemented|单账号/)
    }
  })

  it('T28b: deps.sendGreeting() → throw StubError', async () => {
    const deps = await buildDefaultDeps(baseOpts())
    await expect(deps.sendGreeting({ id: 'j1' } as never)).rejects.toThrow(/stub.*sendGreeting/i)
  })

  it('T28c: deps.loginByQR() → throw StubError (runDailyLoop 会捕获映射 exit 2)', async () => {
    const deps = await buildDefaultDeps(baseOpts())
    await expect(deps.loginByQR()).rejects.toThrow(/stub.*loginByQR/i)
  })

  it('T28d: deps.now/rand 默认注入 (非 undefined)', async () => {
    const deps = await buildDefaultDeps(baseOpts())
    expect(deps.now).toBeInstanceOf(Function)
    expect(deps.rand).toBeInstanceOf(Function)
    expect(typeof deps.now!()).toBe('number')
    expect(deps.rand!()).toBeGreaterThanOrEqual(0)
    expect(deps.rand!()).toBeLessThanOrEqual(1)
  })
})

// ─── D-2b smoke: DEFAULT_SAFETY 暴露 (供 guard.onBlock 用) ───

describe('T29: DEFAULT_SAFETY.consecutive_guard_threshold=3 (D-2a 默认值)', () => {
  it('T29a: DEFAULT_SAFETY.consecutive_guard_threshold === 3', () => {
    expect(DEFAULT_SAFETY.consecutive_guard_threshold).toBe(3)
  })

  it('T29b: guard.onBlock 第 3 次触发 regressWarmup (smoke 全链路)', async () => {
    const initial: AccountMeta = {
      ...baseMeta,
      currentTier: 'old',
      blockedHistory: [
        { ts: Date.now() - 3000, reason: 'anti_bot' },
        { ts: Date.now() - 2000, reason: 'rate_limit' },
      ],
    }
    const accountMetaStore = createInMemoryAccountMetaStore(initial)
    const deps = await buildDefaultDeps(baseOpts({
      accountMetaStoreFactory: () => accountMetaStore,
    }))

    // 第 3 次 → 降档
    await deps.guard!.onBlock('high_failure_rate', null)

    const state = await accountMetaStore.load()
    expect(state.blockedHistory?.length).toBe(3)
    expect(state.currentTier).toBe('warm')  // 触发降档
  })
})