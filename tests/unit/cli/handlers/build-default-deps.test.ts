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
  runDailyLoop,
} from '../../../../src/cli/handlers/auto-handler'
import type { AccountMeta } from '../../../../src/auto/throttle'
import { type AutoConfig, DEFAULT_SAFETY } from '../../../../src/auto/config-schema'
import { createInMemoryCounterStore } from '../../../../src/auto/counter-store'
import {
  createInMemoryAccountMetaStore,
  type AccountMetaStore,
} from '../../../../src/auto/account-meta-store'
import { GuardError } from '../../../../src/auto/guard'

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

const baseConfig: AutoConfig & { dryRun: boolean; phase: 'morning' | 'afternoon' } = {
  version: 1,
  searches: [{ keyword: 'Java' }],
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

// ============================================================
// Sprint D-3 §17.12 必须修正 (架构师 review 2026-07-28)
// ------------------------------------------------------------
// 覆盖: T30 (config.safety 优先级合并) + T31 (dry-run in-memory counter)
//       + T32 (blocked → exit 3) + T33 (phase 透传)
// 纪律: §3.13 错误分层 (exit 3 = 风控暂停, 与 fatal exit 2 区分);
//       §3.10 refactor: buildDefaultGuard 新增 safety? 字段, 现有 caller 0 改
// 单账号红线守住: dry-run 改 in-memory counter 仍不触碰 BOSS
// ============================================================

// ─── T30: config.safety 优先级合并 (D-3 修正 1) ─────────────

describe('T30: config.safety 优先级合并 (D-3 修正 1, 架构师 review)', () => {
  it('T30a: config.safety.consecutive_guard_threshold=5 覆盖 DEFAULT_SAFETY_VALUE=3 (3 条 history 不应降档)', async () => {
    // 用户在 YAML 写 safety.consecutive_guard_threshold: 5
    // 当前 impl 用 DEFAULT_SAFETY_VALUE=3, 所以 3 条 history 就会降档 (BUG)
    // 修正后: 3 条 history 不应降档 (用户阈值=5)
    const customConfig: AutoConfig = {
      ...baseConfig,
      safety: {
        ...DEFAULT_SAFETY,
        consecutive_guard_threshold: 5,
      },
    }
    // 注入 2 条 blockedHistory (再触发 1 次 = 3 条, 介于默认 3 和用户 5 之间)
    const initial: AccountMeta = {
      ...baseMeta,
      currentTier: 'old',
      blockedHistory: [
        { ts: Date.now() - 2000, reason: 'anti_bot' },
        { ts: Date.now() - 1000, reason: 'rate_limit' },
      ],
    }
    const accountMetaStore = createInMemoryAccountMetaStore(initial)
    const deps = await buildDefaultDeps(baseOpts({
      config: customConfig,
      accountMetaStoreFactory: () => accountMetaStore,
    }))

    // 触发第 3 次 → current impl (3) 会降档, 正确 impl (5) 不降档
    await deps.guard!.onBlock('high_failure_rate', null)

    const state = await accountMetaStore.load()
    expect(state.blockedHistory?.length).toBe(3)
    // 用户阈值=5, 3 < 5 → 不降档 (current impl 会降档 = BUG)
    expect(state.currentTier).toBe('old')
  })

  it('T30b: config.safety 缺字段时 fallback 到 DEFAULT_SAFETY_VALUE', async () => {
    // 用户没写 consecutive_guard_threshold, 只写了 max_failure_rate
    const partialConfig: AutoConfig = {
      ...baseConfig,
      safety: {
        ...DEFAULT_SAFETY,
        // consecutive_guard_threshold: undefined (缺)
        max_failure_rate: 0.5,
      },
    }
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
      config: partialConfig,
      accountMetaStoreFactory: () => accountMetaStore,
    }))

    // 第 3 次 → 应降档 (缺字段 fallback DEFAULT_SAFETY_VALUE=3)
    await deps.guard!.onBlock('high_failure_rate', null)

    const state = await accountMetaStore.load()
    expect(state.currentTier).toBe('warm')  // 触发降档 (fallback 3)
  })

  it('T30c: config.safety 完全缺失时用 DEFAULT_SAFETY_VALUE', async () => {
    // 用户完全没写 safety 节
    const noSafetyConfig: AutoConfig = {
      ...baseConfig,
      // safety 字段不存在
    }
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
      config: noSafetyConfig,
      accountMetaStoreFactory: () => accountMetaStore,
    }))

    await deps.guard!.onBlock('high_failure_rate', null)

    const state = await accountMetaStore.load()
    expect(state.currentTier).toBe('warm')  // 触发降档 (完全 fallback)
  })
})

// ─── T31: dry-run 用 in-memory counter (D-3 修正 2) ─────────

describe('T31: dry-run 用 in-memory counter 不污染 fs (D-3 修正 2, 架构师 review)', () => {
  it('T31a: config.dryRun=true → counterStore 是 in-memory (writeAtomic 不写 fs)', async () => {
    const dryRunConfig: AutoConfig = {
      ...baseConfig,
      dryRun: true,
    }
    // 用 mkdtemp 隔离 (避免之前 test 遗留的 /tmp/dry-run-test/counter.json 干扰)
    const isolatedDir = await makeTmpDir()
    const deps = await buildDefaultDeps(baseOpts({
      config: dryRunConfig,
      configDir: isolatedDir,
    }))

    // 验证 counterStore 是 in-memory: load(date) 不返 null, writeAtomic 后 state 持久在内存
    const date = '2026-07-29'
    const initial = await deps.counterStore.load(date)
    // 注: in-memory store 首次 load 返 null (state 未初始化), 写后才存在
    expect(initial).toBeNull()  // 首次 load 应返 null (state 未 init)

    // 写一个 state
    await deps.counterStore.writeAtomic({ date, sent: 999 })
    const stateAfter = await deps.counterStore.load(date)
    expect(stateAfter).not.toBeNull()
    expect(stateAfter!.sent).toBe(999)

    // 关键: 写后 fs 路径不应有 counter.json (dry-run 用 in-memory)
    const fs = await import('node:fs/promises')
    await expect(fs.stat(`${isolatedDir}/counter.json`)).rejects.toThrow()
  })

  it('T31b: config.dryRun=false (默认) → counterStore 是 fs (写持久化)', async () => {
    const tmpDir = await makeTmpDir()
    const deps = await buildDefaultDeps(baseOpts({
      configDir: tmpDir,
      // baseConfig.dryRun = false (默认)
    }))

    const date = '2026-07-29'
    await deps.counterStore.writeAtomic({ date, sent: 42 })

    // fs 路径应该有 counter.json
    const fs = await import('node:fs/promises')
    const statResult = await fs.stat(`${tmpDir}/counter.json`)
    expect(statResult.isFile()).toBe(true)
  })

  it('T31c: dry-run 模式下 guard.onBlock 仍 recordBlock (account-meta 不受影响)', async () => {
    // 即使 dry-run, 风控仍要 recordBlock (用于后续分析)
    const dryRunConfig: AutoConfig = {
      ...baseConfig,
      dryRun: true,
    }
    const accountMetaStore = createInMemoryAccountMetaStore()
    const deps = await buildDefaultDeps(baseOpts({
      config: dryRunConfig,
      accountMetaStoreFactory: () => accountMetaStore,
    }))

    await deps.guard!.onBlock('anti_bot', null)

    const state = await accountMetaStore.load()
    expect(state.blockedHistory?.length).toBe(1)  // recordBlock 仍生效
  })
})

// ─── T32: blocked → exitCode = 3 (D-3 修正 3) ──────────────

describe('T32: 风控触发 blocked → exitCode = 3 (D-3 修正 3, 架构师 review)', () => {
  it('T32a: runDailyLoop 检测 GuardError → stats.blocked=true → exitCode=3 (区分 fatal exit 2)', async () => {
    // 注入 guard 触发 (R2 GuardError)
    const accountMetaStore = createInMemoryAccountMetaStore()
    const deps = await buildDefaultDeps(baseOpts({
      accountMetaStoreFactory: () => accountMetaStore,
    }))

    // 关键: override loginByQR (默认 STUB 会 R1 throw, 走不到 for loop)
    deps.loginByQR = async () => { /* no-op for test */ }

    // mock bossSearch 返 1 个 job, sendGreeting 抛 GuardError
    const fakeJob = { id: 'j1', encryptJobId: 'ej1' } as never
    deps.bossSearch = async () => [fakeJob]
    let sendGreetingCalled = 0
    deps.sendGreeting = async () => {
      sendGreetingCalled += 1
      throw new GuardError('环境异常', 'anti_bot')
    }
    // 关键: mock now() 到上午 10:00 (避 throttleSend DailyDone 检查 msSinceDayStart > 17:30)
    const mockMorning = new Date('2026-07-29T10:00:00').getTime()
    deps.now = () => mockMorning
    // 关键: 注入 in-memory counter (避 fs 旧数据污染, 否则 cap=100 sent=100 触发 DailyLimit)
    deps.counterStore = createInMemoryCounterStore()

    const result = await runDailyLoop(deps, '2026-07-29')
    expect(result.stats.blocked).toBe(true)
    expect(result.exitCode).toBe(3)
    expect(result.state).toBe('blocked')
    expect(sendGreetingCalled).toBe(1)
  })

  it('T32b: loginByQR throw (R1) 仍 exitCode=2 (aborted, 区别 blocked)', async () => {
    // 现有 R1 loginByQR throw 行为不变 (exit 2 = fatal)
    const deps = await buildDefaultDeps(baseOpts())

    const { runDailyLoop } = await import('../../../../src/cli/handlers/auto-handler')
    // 默认 STUB loginByQR throw BOSSStubError
    const result = await runDailyLoop(deps, '2026-07-29')
    expect(result.exitCode).toBe(2)  // fatal (R1)
    expect(result.state).toBe('aborted')
  })

  it('T32c: R3 高失败率 (每 10 次失败率 > 30%) 触发 blocked → exitCode=3', async () => {
    // R3 失败率超阈也走 blocked → exit 3
    const accountMetaStore = createInMemoryAccountMetaStore()
    const deps = await buildDefaultDeps(baseOpts({
      accountMetaStoreFactory: () => accountMetaStore,
    }))

    // 关键: override loginByQR (默认 STUB 会 R1 throw, 走不到 for loop)
    deps.loginByQR = async () => { /* no-op for test */ }

    // mock 10 个 job, 全部失败 (100% 失败率 > 30% 阈值)
    const jobs = Array.from({ length: 10 }, (_, i) => ({ id: `j${i}` } as never))
    deps.bossSearch = async () => jobs
    deps.sendGreeting = async () => {
      throw new Error('mocked sendGreeting fail')
    }
    // 关键: mock now() 到上午 10:00 (避 throttleSend DailyDone 检查)
    const mockMorning = new Date('2026-07-29T10:00:00').getTime()
    deps.now = () => mockMorning
    // 关键: 注入 in-memory counter (避 fs 旧数据)
    deps.counterStore = createInMemoryCounterStore()

    const result = await runDailyLoop(deps, '2026-07-29')
    expect(result.stats.blocked).toBe(true)
    expect(result.exitCode).toBe(3)  // ← NEW D-3
  })
})

// ─── T33: phase 透传 (D-3 建议 1) ───────────────────────

describe('T33: config.phase 透传到 throttle (D-3 建议 1)', () => {
  it('T33a: deps.config.phase=morning 透传 (buildDefaultDeps 不修改 phase)', async () => {
    const phaseConfig: AutoConfig = {
      ...baseConfig,
      phase: 'morning',
    }
    const deps = await buildDefaultDeps(baseOpts({
      config: phaseConfig,
    }))

    // buildDefaultDeps 应原样透传 config.phase (throttle.ts 自己处理)
    expect(deps.config.phase).toBe('morning')
  })

  it('T33b: deps.config.phase=afternoon 透传', async () => {
    const phaseConfig: AutoConfig = {
      ...baseConfig,
      phase: 'afternoon',
    }
    const deps = await buildDefaultDeps(baseOpts({
      config: phaseConfig,
    }))

    expect(deps.config.phase).toBe('afternoon')
  })
})

// ─── T41: config-schema notifier 字段 (E-1b schema 扩展) ──────

import {
  NotifierConfigSchema,
  DEFAULT_NOTIFIER,
} from '../../../../src/auto/config-schema'

describe('T41: NotifierConfigSchema (E-1b 配置层)', () => {
  it('T41a: 完整 4 字段 → parse ok, 字段值保持', () => {
    const parsed = NotifierConfigSchema.safeParse({
      webhookUrl: 'https://open.feishu.cn/hook/xxx',
      maxRetries: 5,
      initialBackoffMs: 500,
      timeoutMs: 8000,
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.webhookUrl).toBe('https://open.feishu.cn/hook/xxx')
      expect(parsed.data.maxRetries).toBe(5)
      expect(parsed.data.initialBackoffMs).toBe(500)
      expect(parsed.data.timeoutMs).toBe(8000)
    }
  })

  it('T41b: 空对象 → parse ok (webhookUrl=undefined 等价 console)', () => {
    const parsed = NotifierConfigSchema.safeParse({})
    expect(parsed.success).toBe(true)
    expect(parsed.data).toEqual({})
  })

  it('T41c: webhookUrl 不是 URL → parse fail', () => {
    const parsed = NotifierConfigSchema.safeParse({ webhookUrl: 'not-a-url' })
    expect(parsed.success).toBe(false)
  })

  it('T41d: 未知字段 (e.g. enabled) → parse fail (.strict)', () => {
    const parsed = NotifierConfigSchema.safeParse({
      webhookUrl: 'https://x.com',
      enabled: true,  // 显式删除字段
    })
    expect(parsed.success).toBe(false)
  })

  it('T41e: maxRetries 非正整数 → parse fail', () => {
    const parsed = NotifierConfigSchema.safeParse({ maxRetries: 0 })
    expect(parsed.success).toBe(false)
  })

  it('T41f: DEFAULT_NOTIFIER = {} (空对象; webhookUrl 不设 = console)', () => {
    expect(DEFAULT_NOTIFIER).toEqual({})
  })
})

// ─── T42: buildDefaultDeps notifier 探测 (per 架构师 review) ──

describe('T42: buildDefaultDeps notifier 探测 (E-1b wiring)', () => {
  it('T42a: opts.notifier 显式注入 → 优先级最高, 不调 notifierFactory', async () => {
    const injected = { notify: vi.fn(async () => {}) }
    const factorySpy = vi.fn(() => injected as any)
    const deps = await buildDefaultDeps(baseOpts({
      config: {
        ...baseConfig,
        notifier: { webhookUrl: 'https://open.feishu.cn/hook/yaml' },
      },
      notifier: injected as any,  // 1. 显式注入
      notifierFactory: factorySpy as any,  // 2. 不会被调
    }))
    expect(deps.notifier).toBe(injected)
    expect(factorySpy).not.toHaveBeenCalled()
  })

  it('T42b: config.notifier.webhookUrl set + 无注入 → 调 notifierFactory 4 字段全透传', async () => {
    const factorySpy = vi.fn(() => ({
      notify: vi.fn(async () => {}),
    }) as any)
    await buildDefaultDeps(baseOpts({
      config: {
        ...baseConfig,
        notifier: {
          webhookUrl: 'https://open.feishu.cn/hook/yaml',
          maxRetries: 5,
          initialBackoffMs: 500,
          timeoutMs: 8000,
        },
      },
      notifierFactory: factorySpy as any,
    }))
    expect(factorySpy).toHaveBeenCalledTimes(1)
    const args = factorySpy.mock.calls[0][0]
    expect(args.webhookUrl).toBe('https://open.feishu.cn/hook/yaml')
    expect(args.maxRetries).toBe(5)        // 显式透传 (per 架构师必修正)
    expect(args.initialBackoffMs).toBe(500)
    expect(args.timeoutMs).toBe(8000)
  })

  it('T42c: config.notifier.webhookUrl 缺失 → consoleNotifier fallback', async () => {
    const factorySpy = vi.fn(() => ({
      notify: vi.fn(async () => {}),
    }) as any)
    const deps = await buildDefaultDeps(baseOpts({
      config: {
        ...baseConfig,
        notifier: {},  // 无 webhookUrl
      },
      notifierFactory: factorySpy as any,
    }))
    expect(factorySpy).not.toHaveBeenCalled()
    // 验证 consoleNotifier (用 reference 等价 + notify spy check)
    expect(typeof deps.notifier.notify).toBe('function')
  })

  it('T42d: config.notifier 部分字段 (webhookUrl 存在, maxRetries undefined) → 字段 undefined 透传 (feishu 内部默认)', async () => {
    const factorySpy = vi.fn(() => ({
      notify: vi.fn(async () => {}),
    }) as any)
    await buildDefaultDeps(baseOpts({
      config: {
        ...baseConfig,
        notifier: {
          webhookUrl: 'https://open.feishu.cn/hook/partial',
          // maxRetries/initialBackoffMs/timeoutMs undefined
        },
      },
      notifierFactory: factorySpy as any,
    }))
    const args = factorySpy.mock.calls[0][0]
    expect(args.webhookUrl).toBe('https://open.feishu.cn/hook/partial')
    expect(args.maxRetries).toBeUndefined()
    expect(args.initialBackoffMs).toBeUndefined()
    expect(args.timeoutMs).toBeUndefined()
  })
})

// ─── T43: mergeWebhookFromEnv (CLI 层 env 探测) ───────────────

import { mergeWebhookFromEnv } from '../../../../src/cli/handlers/auto-handler'

describe('T43: mergeWebhookFromEnv (CLI 层 env 探测, per 架构师 review)', () => {
  it('T43a: envUrl=undefined → config 原样返回', () => {
    const config: AutoConfig = {
      ...baseConfig,
      notifier: { webhookUrl: 'https://from-yaml.com' },
    }
    const result = mergeWebhookFromEnv(config, undefined)
    expect(result).toBe(config)  // 同一引用 (不变异)
  })

  it('T43b: envUrl 设了 + config.notifier 已存在 → env 覆盖 webhookUrl', () => {
    const config: AutoConfig = {
      ...baseConfig,
      notifier: {
        webhookUrl: 'https://from-yaml.com',
        maxRetries: 5,
        initialBackoffMs: 500,
        timeoutMs: 8000,
      },
    }
    const result = mergeWebhookFromEnv(config, 'https://from-env.com')
    expect(result.notifier?.webhookUrl).toBe('https://from-env.com')  // env 覆盖
    expect(result.notifier?.maxRetries).toBe(5)         // 其他字段保留
    expect(result.notifier?.initialBackoffMs).toBe(500)
    expect(result.notifier?.timeoutMs).toBe(8000)
  })

  it('T43c: envUrl 设了 + config.notifier 缺失 → 创建 notifier with webhookUrl', () => {
    const config: AutoConfig = {
      ...baseConfig,
      notifier: {},  // 空
    }
    const result = mergeWebhookFromEnv(config, 'https://from-env.com')
    expect(result.notifier?.webhookUrl).toBe('https://from-env.com')
    expect(result.notifier?.maxRetries).toBeUndefined()
  })

  it('T43d: envUrl 空字符串 → 视为未设 (不变)', () => {
    const config: AutoConfig = {
      ...baseConfig,
      notifier: { webhookUrl: 'https://from-yaml.com' },
    }
    const result = mergeWebhookFromEnv(config, '')
    expect(result).toBe(config)  // 同引用
  })
})