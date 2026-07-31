// ============================================================
// tests/unit/auto/throttle.test.ts — Sprint B-1 §8 RED 5 测试
// ------------------------------------------------------------
// 状态: RED (待 src/auto/throttle.ts GREEN 实现)
// 覆盖: T1-T5 (per ADR-0016 §8 Sprint B-1 清单)
// 纪律: §3.13 错误分层 (ThrottleError.layer='THROTTLE');
//       §3.12 注入 fake clock + seeded RNG (避免假绿)
// 修订: T1 按 §7.4 流程图应为 11:30:00 sleep (lunch_break),
//       ADR §8 草稿写 "11:30:00 throw DailyDone" 误 — 见 §15 报告
// ============================================================

import { describe, it, expect, beforeEach } from 'vitest'
import {
  throttleSend,
  ThrottleError,
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

const makeDeps = (overrides: Partial<ThrottleDeps> = {}): ThrottleDeps => ({
  now,
  rand,
  counterStore: { load: async () => null, writeAtomic: async () => {} },
  accountMeta: metaDay15,
  ...overrides,
})

// ─── T1: 11:30 lunch_break 边界 (per §7.4 流程图修订 ADR §8 笔误) ─

it('T1: 11:29:59 proceed (deadline 前 1s) / 11:30:00 sleep lunch_break', async () => {
  // 11:29:59 → proceed
  setClock(new Date('2026-07-28T11:29:59').getTime())
  let result = await throttleSend({ id: 'j1' }, makeDeps(), baseConfig)
  expect(result.decision).toBe('proceed')
  expect(result.reason).not.toContain('lunch_break')

  // 11:30:00 → sleep until 14:00 (per §7.4 流程图)
  setClock(new Date('2026-07-28T11:30:00').getTime())
  result = await throttleSend({ id: 'j2' }, makeDeps(), baseConfig)
  expect(result.decision).toBe('sleep')
  expect(result.reason).toContain('lunch_break')
  expect(result.sleepMs).toBeGreaterThan(0)
})

// ─── T2: daily cap ────────────────────────────────────────

it('T2: daily.sent >= cap throws ThrottleError(DailyLimit, "daily_cap")', async () => {
  setClock(new Date('2026-07-28T09:10:00').getTime())
  const fullCounter: DailyCounter = { ...baseCounter, sent: 50, cap: 50 }
  const deps = makeDeps({
    counterStore: { load: async () => fullCounter },
  })

  await expect(throttleSend({ id: 'j1' }, deps, baseConfig)).rejects.toThrow(ThrottleError)
  await expect(throttleSend({ id: 'j1' }, deps, baseConfig)).rejects.toThrow(/daily_cap/)

  try {
    await throttleSend({ id: 'j1' }, deps, baseConfig)
  } catch (e) {
    expect(e).toBeInstanceOf(ThrottleError)
    expect((e as ThrottleError).code).toBe('DailyLimit')
    expect((e as ThrottleError).layer).toBe('THROTTLE')  // per §3.13
  }
})

// ─── T3: 周末 block (dry-run 放行) ──────────────────────

it('T3: Sat throws WeekendBlock; dry-run mode passes weekend', async () => {
  // 2026-07-25 is Saturday
  setClock(new Date('2026-07-25T10:00:00').getTime())
  const deps = makeDeps()

  // dry-run=false → throw
  await expect(throttleSend({ id: 'j1' }, deps, { ...baseConfig, dryRun: false })).rejects.toThrow(ThrottleError)
  try {
    await throttleSend({ id: 'j1' }, deps, { ...baseConfig, dryRun: false })
  } catch (e) {
    expect((e as ThrottleError).code).toBe('WeekendBlock')
  }

  // dry-run=true → proceed
  const result = await throttleSend({ id: 'j2' }, deps, { ...baseConfig, dryRun: true })
  expect(result.decision).toBe('proceed')
  expect(result.reason).toContain('weekend_dry_run')
})

// ─── T4: warmup cap (Day1=50 / Day8=70 / Day15=100) ─────

it('T4: warmup Day1 cap=50 / Day8 cap=70 / Day15 cap=100', async () => {
  setClock(new Date('2026-07-28T09:10:00').getTime())

  // Day 1
  const meta1: AccountMeta = { ...metaDay15, accountAgeDays: 1 }
  let result = await throttleSend({ id: 'j1' }, makeDeps({ accountMeta: meta1 }), baseConfig)
  expect(result.reason).toContain('/50')

  // Day 8
  const meta8: AccountMeta = { ...metaDay15, accountAgeDays: 8 }
  result = await throttleSend({ id: 'j2' }, makeDeps({ accountMeta: meta8 }), baseConfig)
  expect(result.reason).toContain('/70')

  // Day 15
  const meta15: AccountMeta = { ...metaDay15, accountAgeDays: 15 }
  result = await throttleSend({ id: 'j3' }, makeDeps({ accountMeta: meta15 }), baseConfig)
  expect(result.reason).toContain('/100')
})

// ─── T5: longPause 注入 ────────────────────────────────────

it('T5: sent % 20 == 0 triggers longPause (sleepMs > 240_000)', async () => {
  setClock(new Date('2026-07-28T09:30:00').getTime())
  seedRandom(42)
  const counter20: DailyCounter = { ...baseCounter, sent: 20, cap: 40 }
  const deps = makeDeps({
    counterStore: { load: async () => counter20, writeAtomic: async () => {} },
  })

  const result = await throttleSend({ id: 'j1' }, deps, baseConfig)
  expect(result.decision).toBe('proceed')
  // morning max interval = 240_000, longPause >= 300_000 → 总 sleepMs > 240_000
  expect(result.sleepMs).toBeGreaterThan(240_000)
})
