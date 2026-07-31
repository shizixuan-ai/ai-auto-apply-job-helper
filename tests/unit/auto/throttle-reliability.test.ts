// ============================================================
// tests/unit/auto/throttle-reliability.test.ts — Sprint B-2 §8 RED 5 测试
// ------------------------------------------------------------
// 状态: RED (待 src/auto/throttle.ts GREEN 扩 + 新增 src/auto/session-detector.ts)
// 覆盖: T6-T10 (per ADR-0016 §8 Sprint B-2 清单 + §12)
// 纪律: §3.13 错误分层 (ThrottleError/SessionExpiredError.layer);
//       §3.12 注入 fake clock + seeded RNG + mock counterStore
// ============================================================

import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  throttleSend,
  ThrottleError,
  SessionExpiredError,
  type ThrottleDeps,
  type AutoConfig,
  type AccountMeta,
  type DailyCounter,
} from '../../../src/auto/throttle'

// ─── 共享 fake clock + seeded RNG (per §3.12) ────────────────

let _now = Date.now()
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

beforeEach(() => {
  setClock(Date.now())
  seedRandom(0)
})

// ─── 默认 fixtures ───────────────────────────────────────────

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

const baseConfig: AutoConfig = {
  dryRun: false,
  phase: 'morning',
  quota: { morning: 40, afternoon: 60, weekly_cap: 500 },
  throttle: {
    morning_interval_ms: [180_000, 240_000],
    afternoon_interval_ms: [150_000, 195_000],
    jitter_pct: 20,
    long_pause: { every_n_jobs: 20, duration_ms: [300_000, 600_000] },
    afternoon_mid_break: { after_job: 30, duration_ms: [600_000, 900_000] },
  },
}

const baseCounter: DailyCounter = {
  date: '2026-07-28',
  sent: 0,
  cap: 40,
  phase: 'morning',
  quotaMorning: 40,
  quotaAfternoon: 60,
  lastSentAt: 0,
  longPausesInjected: 0,
  bigBreakInjected: false,
}

const noopSendGreeting = async () => {}
const noopLoginByQR = async () => {}

const makeDeps = (overrides: Partial<ThrottleDeps> = {}): ThrottleDeps => ({
  now,
  rand,
  counterStore: {
    load: async () => null,
    writeAtomic: async () => {},
  },
  sendGreeting: noopSendGreeting,
  loginByQR: noopLoginByQR,
  accountMeta: metaDay15,
  ...overrides,
})

// ─── T6: bigBreak 单次注入 (per §12 Issue 2 — Sprint B-1 已实现, 验证) ─

it('T6a: bigBreak sent=30 触发 (cap=60, after_job=30, slept > 195_000)', async () => {
  setClock(new Date('2026-07-28T14:30:00').getTime())
  seedRandom(0)
  const counter: DailyCounter = { ...baseCounter, sent: 30, cap: 60, phase: 'afternoon', bigBreakInjected: false }
  const deps = makeDeps({
    counterStore: { load: async () => counter, writeAtomic: async () => {} },
  })
  const result = await throttleSend({ id: 'j1' }, deps, { ...baseConfig, phase: 'afternoon' })
  expect(result.decision).toBe('proceed')
  // afternoon 默认最大 interval = 195_000, bigBreak 600-900s → 总 > 195_000
  expect(result.sleepMs).toBeGreaterThan(195_000)
})

it('T6b: bigBreak sent=31 不触发 (flag 持久化, slept < 195_000)', async () => {
  setClock(new Date('2026-07-28T14:30:00').getTime())
  seedRandom(0)
  const counter: DailyCounter = { ...baseCounter, sent: 31, cap: 60, phase: 'afternoon', bigBreakInjected: true }
  const deps = makeDeps({
    counterStore: { load: async () => counter, writeAtomic: async () => {} },
  })
  const result = await throttleSend({ id: 'j1' }, deps, { ...baseConfig, phase: 'afternoon' })
  expect(result.decision).toBe('proceed')
  // 已注入过, 只剩下午 interval (no bigBreak)
  expect(result.sleepMs).toBeLessThan(195_000)
})

// ─── T7: counter 原子写 (per §12 Issue 1) ───────────────────

it('T7: counter++ + writeAtomic 先于 sendGreeting; sendGreeting 抛错时 counter 已落盘', async () => {
  setClock(new Date('2026-07-28T09:10:00').getTime())
  seedRandom(0)
  const calls: string[] = []
  const counter: DailyCounter = { ...baseCounter, sent: 0, cap: 40 }
  const deps = makeDeps({
    counterStore: {
      load: async () => ({ ...counter }),
      writeAtomic: async (c: DailyCounter) => {
        calls.push(`writeAtomic(sent=${c.sent})`)
        Object.assign(counter, c)  // 内存模拟落盘
      },
    },
    sendGreeting: async () => {
      calls.push('sendGreeting')
      throw new Error('BOSS 投递失败')
    },
  })

  // 第一次 throttleSend: counter++ + writeAtomic → sendGreeting 抛错 → throw
  await expect(throttleSend({ id: 'j1' }, deps, baseConfig)).rejects.toThrow(/BOSS 投递失败/)

  // 验证顺序: writeAtomic 在 sendGreeting 之前
  expect(calls).toEqual(['writeAtomic(sent=1)', 'sendGreeting'])

  // 验证 counter 已 +1 落盘 (sent=1)
  expect(counter.sent).toBe(1)
})

// ─── T8: SIGTERM handler (per §12 Issue 1 step 4) ──────────

it('T8: SIGTERM 触发时强制 flush counter + fsync 落盘', async () => {
  setClock(new Date('2026-07-28T09:10:00').getTime())
  seedRandom(0)
  const counter: DailyCounter = { ...baseCounter, sent: 0, cap: 40 }
  const writesBefore: number[] = []
  const deps = makeDeps({
    counterStore: {
      load: async () => ({ ...counter }),
      writeAtomic: async (c: DailyCounter) => {
        writesBefore.push(c.sent)
        Object.assign(counter, c)
      },
    },
  })

  // 触发 SIGTERM handler (throttleSend 内 installSignal 选项开启)
  await throttleSend({ id: 'j1' }, deps, { ...baseConfig, installSignal: true } as AutoConfig & { installSignal?: boolean })

  // 模拟 SIGTERM
  const sig = (process.listeners('SIGTERM') as Array<() => void>).at(-1)
  expect(sig, '应该已注册 SIGTERM handler').toBeDefined()
  if (sig) sig()

  // 验证 writeAtomic 在 SIGTERM 触发后被调 (落盘)
  expect(writesBefore.length).toBeGreaterThanOrEqual(2)  // 至少 1 次正常 + 1 次 SIGTERM flush
  expect(counter.sent).toBe(1)
})

// ─── T9: SessionExpiredError 触发重登 (per §12 Issue 3) ─────

it('T9: sendGreeting 抛 SessionExpiredError → 调 loginByQR 重登 1 次 → 成功后 retry', async () => {
  setClock(new Date('2026-07-28T09:10:00').getTime())
  seedRandom(0)
  let loginCount = 0
  let sendCount = 0
  const counter: DailyCounter = { ...baseCounter, sent: 0, cap: 40 }
  const deps = makeDeps({
    counterStore: {
      load: async () => ({ ...counter }),
      writeAtomic: async (c: DailyCounter) => { Object.assign(counter, c) },
    },
    sendGreeting: async () => {
      sendCount += 1
      if (sendCount === 1) throw new SessionExpiredError('401 from BOSS')
      // 第二次成功
    },
    loginByQR: async () => { loginCount += 1 },
  })

  const result = await throttleSend({ id: 'j1' }, deps, baseConfig)
  expect(result.decision).toBe('proceed')
  expect(loginCount).toBe(1)  // 重登 1 次
  expect(sendCount).toBe(2)   // 投递 2 次 (第 1 次 fail, 第 2 次成功)
  expect(counter.sent).toBe(1)  // 最终成功 +1
})

// ─── T10: SessionExpiredError 重登失败 throw (per §12 Issue 3 上限) ─

it('T10: sendGreeting 抛 SessionExpiredError + loginByQR 也失败 → throw (走 guard pause)', async () => {
  setClock(new Date('2026-07-28T09:10:00').getTime())
  seedRandom(0)
  let loginCount = 0
  let sendCount = 0
  const counter: DailyCounter = { ...baseCounter, sent: 0, cap: 40 }
  const deps = makeDeps({
    counterStore: {
      load: async () => ({ ...counter }),
      writeAtomic: async (c: DailyCounter) => { Object.assign(counter, c) },
    },
    sendGreeting: async () => {
      sendCount += 1
      throw new SessionExpiredError('401 from BOSS')
    },
    loginByQR: async () => {
      loginCount += 1
      throw new Error('login failed')
    },
  })

  await expect(throttleSend({ id: 'j1' }, deps, baseConfig)).rejects.toThrow(/login failed/)
  expect(loginCount).toBe(1)  // 仅 1 次, 不无限循环
  expect(sendCount).toBe(1)   // 重登 1 次失败后直接 throw, 不 retry 第 2 次
  // 关键: counter.sent 已 +1 (T7 顺序倒置语义)
  expect(counter.sent).toBe(1)
})

// ─── T20: 加固 SIGTERM handler 不调 process.exit (per §14.8 F5 + R5) ─

it('T20: SIGTERM handler 完成后不调 process.exit (per §14.8 F5 + R5)', async () => {
  // §3.10 refactor + R5 加固: 显式断言 handler 内禁止调 process.exit
  // 否则 cron 误以为 "完成" 而下次 run 误读 counter 状态
  setClock(new Date('2026-07-28T09:10:00').getTime())
  seedRandom(0)

  const counter: DailyCounter = { ...baseCounter, sent: 0, cap: 40 }
  const writes: number[] = []
  const deps = makeDeps({
    counterStore: {
      load: async () => ({ ...counter }),
      writeAtomic: async (c: DailyCounter) => {
        writes.push(c.sent)
        Object.assign(counter, c)
      },
    },
  })

  // 1) 触发 throttleSend 装 SIGTERM handler
  await throttleSend(
    { id: 'j1' },
    deps,
    { ...baseConfig, installSignal: true } as AutoConfig & { installSignal?: boolean },
  )

  // 2) mock process.exit: 若被调, 抛错让测试 fail (per §14.8 F5)
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('process.exit called inside SIGTERM handler (per §14.8 F5 + R5 must NOT call exit)')
  }) as never)

  try {
    // 3) 取出并触发 SIGTERM handler
    const sig = (process.listeners('SIGTERM') as Array<() => void>).at(-1)
    expect(sig, '应该已注册 SIGTERM handler').toBeDefined()
    if (sig) sig()

    // 关键断言 1: handler 内部未触发 process.exit (没抛 → 没被调)
    expect(exitSpy).not.toHaveBeenCalled()

    // 关键断言 2: writeAtomic 至少 2 次 (1 正常 + 1 SIGTERM flush)
    expect(writes.length).toBeGreaterThanOrEqual(2)
    expect(writes.at(-1)).toBe(1)  // 最后一次 write sent=1 (flush 时 counter 状态)
    expect(counter.sent).toBe(1)
  } finally {
    exitSpy.mockRestore()
  }
})
