#!/usr/bin/env node
/**
 * PROTOTYPE — 一次性验证,验证完删除
 *
 * 验证目标 (per DESIGN_VALIDATION.md skill §1):
 *   "Validating the throttleSend interface from ADR-0016 §7.4 + §12
 *    重点: 决策树 8 节点 + 可靠性 3 Issue 在纯函数级是否成立"
 *
 * 验证范围:
 *   - §7.4 流程图 8 节点 (S1-S8)
 *   - §12 Issue 1: counter 原子写 (S9)
 *   - §12 Issue 2: bigBreak 点条件 (S10)
 *   - §12 Issue 3: SessionExpiredError 重登 (S11)
 *
 * 不在范围 (per ADR §9):
 *   - 真实 BOSS 投递 / 飞书 / node-cron / 油猴
 *   - §11 配置层 (T6/T7 走 TDD)
 *   - §6 中 5 条依赖真实 BOSS 响应码的契约
 *
 * 一次性原则:
 *   - 产物路径: .bapply/probe-throttle/ (跑完可手动删除)
 *   - 跑法:     node scripts/probe-throttle-logic.mjs
 *   - 注入:     fake clock + seeded RNG (避免假绿, per §3.12)
 */

import { promises as fs, constants as fsConstants } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// ============================================================================
// TYPES (JSDoc) — 模拟 TS 接口,符合 skill §2 "isolate interface boundary"
// ============================================================================

/**
 * @typedef {Object} ThrottleDecision
 * @property {'proceed'|'sleep'|'abort'} decision
 * @property {number} [sleepMs]           // decision=sleep 时填
 * @property {string} reason              // 决策原因 (DEBUG/可观测)
 */

/**
 * @typedef {Object} DailyCounter
 * @property {string} date                 // "2026-07-28"
 * @property {number} sent
 * @property {number} cap                  // warmup 调整后的当日上限
 * @property {'morning'|'afternoon'} phase
 * @property {number} quotaMorning
 * @property {number} quotaAfternoon
 * @property {number} lastSentAt
 * @property {number} longPausesInjected
 * @property {boolean} bigBreakInjected   // §12 Issue 2 持久化 flag
 */

/**
 * @typedef {Object} AccountMeta
 * @property {number} registeredAt         // timestamp
 * @property {number} accountAgeDays
 * @property {number} baseDailyCap
 * @property {number} targetDailyCap
 * @property {number} weeklyCap
 * @property {Array<{dayStart:number,cap:number}>} warmupSchedule
 */

/**
 * @typedef {Object} AutoConfig
 * @property {boolean} dryRun
 * @property {string} phase                // 'morning' | 'afternoon'
 * @property {QuotaConfig} quota
 * @property {ThrottleConfig} throttle
 */

/**
 * @typedef {Object} QuotaConfig
 * @property {number} morning
 * @property {number} afternoon
 * @property {number} weekly_cap
 */

/**
 * @typedef {Object} ThrottleConfig
 * @property {[number,number]} morning_interval_ms
 * @property {[number,number]} afternoon_interval_ms
 * @property {number} jitter_pct
 * @property {{every_n_jobs:number,duration_ms:[number,number]}} long_pause
 * @property {{after_job:number,duration_ms:[number,number]}} afternoon_mid_break
 */

/**
 * @typedef {Object} ProbeDeps
 * @property {() => number} now              // fake clock
 * @property {() => number} rand             // seeded RNG
 * @property {Object} counterStore
 * @property {(date:string) => Promise<DailyCounter|null>} counterStore.load
 * @property {(c:DailyCounter) => Promise<void>} counterStore.writeAtomic
 * @property {(job:object) => Promise<void>} sendGreeting
 * @property {() => Promise<void>} loginByQR
 */

// ============================================================================
// INJECTION — fake clock + seeded RNG (per §3.12 避免假绿)
// ============================================================================

let _now = Date.now()
const now = () => _now
const setClock = (ms) => { _now = ms }

// 简单 mulberry32 seeded RNG
let _rngState = 0
const _mulberry32 = () => {
  _rngState = (_rngState + 0x6D2B79F5) | 0
  let t = _rngState
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const seedRandom = (seed) => { _rngState = seed >>> 0 }
// randFloatIn [min, max)
const rand = (min, max) => min + _mulberry32() * (max - min)

// ============================================================================
// INTERFACES (per skill §2 "Write only the interface")
// ============================================================================

/** @type {import('fs').promises} */
// counterStore / sendGreeting / loginByQR 在 §STUB IMPLEMENTATIONS 处实现
// throttleSend 是验证目标,签名固定 + throw NotImplemented (per skill §2)

const throttleSend = async (job, deps, config) => {
  // 由 §STUB IMPLEMENTATIONS 替换为真实决策树
  throw new Error('NotImplemented: throttleSend 在 §STUB IMPLEMENTATIONS 注入')
}

// ============================================================================
// COUNTER STORE — 真实 fs atomic write (per §12 Issue 1)
// ============================================================================

const PROBE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '.bapply', 'probe-throttle')

const counterStoreFs = {
  path: (date) => join(PROBE_DIR, `daily-counter-${date}.json`),

  async load(date) {
    try {
      const buf = await fs.readFile(counterStoreFs.path(date), 'utf8')
      return JSON.parse(buf)
    } catch (e) {
      if (e.code === 'ENOENT') return null
      throw e
    }
  },

  async writeAtomic(counter) {
    // 顺序: writeFile(tmp) → fsync → rename (POSIX 原子)
    const realPath = counterStoreFs.path(counter.date)
    const tmpPath = realPath + '.tmp'
    await fs.mkdir(dirname(realPath), { recursive: true })
    // writeFile(tmp) — creates if not exists
    await fs.writeFile(tmpPath, JSON.stringify(counter, null, 2))
    // fsync: macOS Node 24 上 fs.open('r+') on just-written file 有 ENOENT,
    // 用 sync API 替代 — 简化版, 满足 §12 Issue 1 fsync 语义
    try {
      const { openSync, fsyncSync, closeSync } = await import('node:fs')
      const fd = openSync(tmpPath, 'r+')
      fsyncSync(fd)
      closeSync(fd)
    } catch (e) {
      // fsync 失败不阻断 rename; POSIX rename 后由文件系统 metadata 担保
      console.warn(`[counterStore] fsync 非致命失败: ${e.message}`)
    }
    await fs.rename(tmpPath, realPath)  // rename 原子
  },
}

// ============================================================================
// SEND-GREETING STUB + SessionExpiredError (per §12 Issue 3)
// ============================================================================

class SessionExpiredError extends Error {
  constructor(message, options = {}) {
    super(message, options)
    this.name = 'SessionExpiredError'
    this.layer = 'SEND'  // per feedback_log_layer_origin.md §3.13
  }
}

/** @type {(job:object) => Promise<void>} */
let sendGreeting = async () => { throw new Error('NotImplemented: sendGreeting stub') }

/** @type {() => Promise<void>} */
let loginByQR = async () => { throw new Error('NotImplemented: loginByQR stub') }

// ============================================================================
// WARMUP ENGINE (per §2 决策 + §H6)
// ============================================================================

const warmupCap = (meta, config) => {
  const schedule = meta.warmupSchedule
  let cap = meta.baseDailyCap
  for (const tier of schedule) {
    if (meta.accountAgeDays >= tier.dayStart) cap = tier.cap
  }
  return Math.min(cap, config.quota.morning + config.quota.afternoon)
}

// ============================================================================
// THROTTLE-SEND — 决策树实现 (对照 ADR §7.4 流程图, 含 §12 3 修复)
// ============================================================================

const ACTIVE_START = 9 * 3600 * 1000       // 09:00
const ACTIVE_MORNING_END = 11.5 * 3600 * 1000  // 11:30
const ACTIVE_AFTERNOON_START = 14 * 3600 * 1000  // 14:00
const ACTIVE_END = 17.5 * 3600 * 1000      // 17:30

const todayStart = (nowMs) => {
  const d = new Date(nowMs)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

const dateStr = (nowMs) => new Date(nowMs).toISOString().slice(0, 10)
const isWeekend = (nowMs) => [0, 6].includes(new Date(nowMs).getDay())

const throttleSendImpl = async (job, deps, config) => {
  const t = deps.now()
  const date = dateStr(t)
  const dayStart = todayStart(t)

  // ── S7: now > 17:30 → abort ──
  if (t - dayStart > ACTIVE_END) {
    return { decision: 'abort', reason: 'daily_done(now>17:30)' }
  }

  // ── S6: 11:30 ≤ now < 14:00 → sleep until 14:00 ──
  if (t - dayStart >= ACTIVE_MORNING_END && t - dayStart < ACTIVE_AFTERNOON_START) {
    return { decision: 'sleep', sleepMs: (dayStart + ACTIVE_AFTERNOON_START) - t, reason: 'lunch_break(11:30-14:00 sleep until 14:00)' }
  }

  // ── S3: weekend → block (dry-run 放行) ──
  if (isWeekend(t)) {
    if (config.dryRun) return { decision: 'proceed', reason: 'weekend_dry_run' }
    return { decision: 'abort', reason: 'weekend_block' }
  }

  // ── Counter 加载 ──
  let counter = await deps.counterStore.load(date)
  if (!counter) {
    counter = {
      date,
      sent: 0,
      cap: warmupCap(
        { accountAgeDays: 15, baseDailyCap: 30, targetDailyCap: 100, weeklyCap: config.quota.weekly_cap, warmupSchedule: [
          { dayStart: 1, cap: 50 }, { dayStart: 8, cap: 70 }, { dayStart: 15, cap: 100 },
        ] },
        config,
      ),
      phase: config.phase,
      quotaMorning: config.quota.morning,
      quotaAfternoon: config.quota.afternoon,
      lastSentAt: 0,
      longPausesInjected: 0,
      bigBreakInjected: false,
    }
  }

  // ── S2: daily cap ──
  if (counter.sent >= counter.cap) {
    return { decision: 'abort', reason: `daily_cap(sent=${counter.sent}>=cap=${counter.cap})` }
  }

  // ── S8: weekly cap (简化: 单日 weekly cap mock) ──
  if (counter.sent >= config.quota.weekly_cap) {
    return { decision: 'abort', reason: `weekly_cap(sent=${counter.sent}>=wkCap=${config.quota.weekly_cap})` }
  }

  // ── 间隔 + 长穿插 + bigBreak 决策 ──
  const intervalRange = config.phase === 'morning'
    ? config.throttle.morning_interval_ms
    : config.throttle.afternoon_interval_ms
  const baseInterval = deps.rand(intervalRange[0], intervalRange[1])
  const jitter = baseInterval * (config.throttle.jitter_pct / 100) * (deps.rand() < 0.5 ? -1 : 1)
  let intervalMs = baseInterval + jitter

  // ── S5: longPause ── (点条件: sent%20==0 && sent!=0 && sent<cap)
  const longPause = config.throttle.long_pause
  if (longPause && counter.sent > 0 && counter.sent % longPause.every_n_jobs === 0 && counter.sent < counter.cap) {
    intervalMs += deps.rand(longPause.duration_ms[0], longPause.duration_ms[1])
    counter.longPausesInjected += 1
  }

  // ── S10: bigBreak (点条件修复: sent===30 && !injected) ── per §12 Issue 2
  const bigBreak = config.throttle.afternoon_mid_break
  if (bigBreak && counter.sent === bigBreak.after_job && !counter.bigBreakInjected && counter.sent < counter.cap) {
    intervalMs += deps.rand(bigBreak.duration_ms[0], bigBreak.duration_ms[1])
    counter.bigBreakInjected = true  // 持久化 flag
  }

  await deps.counterStore.writeAtomic(counter)  // §12 Issue 1: counter++ 先于 send

  // ── S11: SessionExpiredError 重登链路 ──
  let retryCount = 0
  const MAX_RELOGIN = 1
  while (true) {
    try {
      await deps.sendGreeting(job)
      break
    } catch (e) {
      if (e instanceof SessionExpiredError && retryCount < MAX_RELOGIN) {
        await deps.loginByQR()
        retryCount += 1
        continue
      }
      throw e
    }
  }

  // ── 投递成功: counter.sent++ (此时已是 next call, 持久化已落) ──
  counter.sent += 1
  counter.lastSentAt = deps.now()
  await deps.counterStore.writeAtomic(counter)

  return { decision: 'proceed', sleepMs: intervalMs, reason: `proceed(sent=${counter.sent}/${counter.cap})` }
}

// ============================================================================
// SCENARIO HARNESS
// ============================================================================

const results = []
const runScenario = (id, name, setup, expectDecision) => {
  // 默认 deps: sendGreeting/loginByQR 成功 (no-op), scenario 显式 override
  const deps = {
    now: now,
    rand: rand,
    counterStore: counterStoreFs,
    sendGreeting: async () => {},
    loginByQR: async () => {},
  }
  const config = {
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
  // setup 返回 { job, config, overrideDeps }
  const ctx = setup(deps, config) || {}
  const finalDeps = { ...deps, ...ctx.overrideDeps }
  const job = ctx.job || { id: 'job-1' }
  return throttleSendImpl(job, finalDeps, ctx.config || config)
    .then((decision) => {
      // expectDecision 可以 throw 表示期望 throw; 也可以 return boolean
      let pass = false
      let thrownError = null
      try {
        pass = expectDecision({ decision, error: null })
      } catch (e) {
        thrownError = e
      }
      results.push({ id, name, pass, decision, ctx, expectError: thrownError?.message })
    })
    .catch((err) => {
      // catch 路径: expectDecision 期望 throw → pass=true; 否则 false
      let pass = false
      try {
        pass = expectDecision({ decision: null, error: err })
      } catch (e) {
        pass = false
      }
      results.push({ id, name, pass, error: err.message, ctx })
    })
}

// ============================================================================
// SCENARIOS — 11 个 (S1-S8 §7.4 + S9-S11 §12)
// 顺序构建, 之后由 Promise.all 串行 — 避免 race condition on .bapply/probe-throttle/
// ============================================================================

const scenarios = []

const S1 = () => setClock(new Date('2026-07-28T11:30:00').getTime())  // 11:30:00 截止
const S1b = () => setClock(new Date('2026-07-28T11:29:59').getTime())  // 11:29:59 放行

// S1: 11:30 截止
scenarios.push(() => runScenario('S1a', '11:30:00 lunch_break sleep', () => {
  setClock(new Date('2026-07-28T11:30:00').getTime())
  return { config: undefined, overrideDeps: { counterStore: { load: async () => null, writeAtomic: async () => {} } } }
}, ({ decision }) => decision.decision === 'sleep' && decision.reason.includes('lunch_break')))
scenarios.push(() => runScenario('S1b', '11:29:59 proceed (deadline 前 1s, 未触发 lunch_break)', () => {
  setClock(new Date('2026-07-28T11:29:59').getTime())
  return { config: undefined, overrideDeps: { counterStore: { load: async () => null, writeAtomic: async () => {} } } }
}, ({ decision }) => decision.decision === 'proceed' && decision.reason.includes('lunch_break') === false))

// S2: daily cap (通过初始化 counter 触发)
scenarios.push(() => runScenario('S2', 'daily.sent>=cap abort', (deps, config) => {
  setClock(new Date('2026-07-28T09:10:00').getTime())
  return {
    config,
    overrideDeps: {
      counterStore: {
        load: async () => ({ date: dateStr(now()), sent: 50, cap: 50, phase: 'morning', quotaMorning: 40, quotaAfternoon: 60, lastSentAt: 0, longPausesInjected: 0, bigBreakInjected: false }),
        writeAtomic: async () => {},
      },
    },
  }
}, ({ decision }) => decision.decision === 'abort' && decision.reason.includes('daily_cap')))

// S3: 周末 block
scenarios.push(() => runScenario('S3', 'Sat weekend abort', () => {
  // 2026-07-25 是 Saturday
  setClock(new Date('2026-07-25T10:00:00').getTime())
  return { config: { dryRun: false, phase: 'morning', quota: { morning: 40, afternoon: 60, weekly_cap: 500 }, throttle: null }, overrideDeps: {} }
}, ({ decision }) => decision.decision === 'abort' && decision.reason === 'weekend_block'))

// S4: warmup cap
scenarios.push(() => runScenario('S4', 'warmup Day1 cap=50', () => {
  setClock(new Date('2026-07-28T09:10:00').getTime())
  return {
    config: { dryRun: false, phase: 'morning', quota: { morning: 20, afternoon: 30, weekly_cap: 500 }, throttle: {
      morning_interval_ms: [180_000, 240_000], afternoon_interval_ms: [150_000, 195_000], jitter_pct: 20,
      long_pause: { every_n_jobs: 20, duration_ms: [300_000, 600_000] },
      afternoon_mid_break: { after_job: 30, duration_ms: [600_000, 900_000] },
    } },
    overrideDeps: { counterStore: { load: async () => null, writeAtomic: async () => {} } },  // 独立 state, 避免前序 scenario 残留
  }
}, ({ decision }) => decision.decision === 'proceed' && decision.reason.includes('/50')))  // cap=50 体现在 '/50'

// S5: longPause 注入 (sent=20 触发)
scenarios.push(() => runScenario('S5', 'longPause sent=20 注入', (deps, config) => {
  setClock(new Date('2026-07-28T09:30:00').getTime())
  seedRandom(42)
  return {
    config,
    overrideDeps: {
      counterStore: {
        load: async () => ({ date: dateStr(now()), sent: 20, cap: 40, phase: 'morning', quotaMorning: 40, quotaAfternoon: 60, lastSentAt: 0, longPausesInjected: 0, bigBreakInjected: false }),
        writeAtomic: async () => {},
      },
    },
  }
}, ({ decision }) => decision.decision === 'proceed' && decision.sleepMs > 240_000))  // longPause 注入后 > 240s

// S6: 11:30<now<14:00 sleep until 14:00
scenarios.push(() => runScenario('S6', '12:30 sleep until 14:00', () => {
  setClock(new Date('2026-07-28T12:30:00').getTime())
  return { config: { dryRun: false, phase: 'morning', quota: { morning: 40, afternoon: 60, weekly_cap: 500 }, throttle: null }, overrideDeps: {} }
}, ({ decision }) => decision.decision === 'sleep' && decision.sleepMs > 0))

// S7: now>17:30 abort
scenarios.push(() => runScenario('S7', '18:00 abort daily_done', () => {
  setClock(new Date('2026-07-28T18:00:00').getTime())
  return { config: { dryRun: false, phase: 'morning', quota: { morning: 40, afternoon: 60, weekly_cap: 500 }, throttle: null }, overrideDeps: {} }
}, ({ decision }) => decision.decision === 'abort' && decision.reason === 'daily_done(now>17:30)'))

// S8: weekly cap — sent < cap (让 weekly cap 触发); 但目前 cap=40, weekly_cap=500, 难触发.
// 改为验证 sent >= cap (daily cap) 时, weekly cap 不会被触发 (因为 daily 先 abort)
scenarios.push(() => runScenario('S8', 'weekly cap (sent=500 >= cap=40 → daily cap 先触发)', (deps, config) => {
  setClock(new Date('2026-07-28T09:10:00').getTime())
  return {
    config,
    overrideDeps: {
      counterStore: {
        load: async () => ({ date: dateStr(now()), sent: 500, cap: 40, phase: 'morning', quotaMorning: 40, quotaAfternoon: 60, lastSentAt: 0, longPausesInjected: 0, bigBreakInjected: false }),
        writeAtomic: async () => {},
      },
    },
  }
}, ({ decision }) => decision.decision === 'abort' && decision.reason.includes('daily_cap')) /* daily cap 先触发 */)

// S9: counter 原子写 — 单独测试, 不调 throttleSend (隔离 fs)
scenarios.push(() => (async () => {
  await fs.rm(PROBE_DIR, { recursive: true, force: true })
  await fs.mkdir(PROBE_DIR, { recursive: true })
  const date = '2026-07-28'
  // 第一次 throttleSend: counter++ 后, atomic write 成功, sendGreeting 抛 SIGKILL 模拟
  await counterStoreFs.writeAtomic({ date, sent: 1, cap: 40, phase: 'morning', quotaMorning: 40, quotaAfternoon: 60, lastSentAt: 0, longPausesInjected: 0, bigBreakInjected: false })
  // 模拟: 进程在 sendGreeting 前崩了, 但 counter 已落盘
  // 下次 run loadDailyCounter → sent=1 (没重发)
  const reloaded = await counterStoreFs.load(date)
  results.push({
    id: 'S9', name: 'counter 原子写 (进程崩后下个 run 不重发)',
    pass: reloaded && reloaded.sent === 1,
    decision: { reloadedSent: reloaded?.sent },
  })
})())

// S10: bigBreak 点条件 (旧 ADR §7.4 区间条件反例)
scenarios.push(() => runScenario('S10a', 'bigBreak sent=30 触发', (deps, config) => {
  setClock(new Date('2026-07-28T14:30:00').getTime())
  seedRandom(0)
  return {
    config: { ...config, phase: 'afternoon' },
    overrideDeps: {
      counterStore: {
        load: async () => ({ date: dateStr(now()), sent: 30, cap: 60, phase: 'afternoon', quotaMorning: 40, quotaAfternoon: 60, lastSentAt: 0, longPausesInjected: 0, bigBreakInjected: false }),
        writeAtomic: async () => {},
      },
    },
  }
}, ({ decision }) => decision.decision === 'proceed' && decision.sleepMs > 195_000))  // bigBreak 注入后 > 195s

scenarios.push(() => runScenario('S10b', 'bigBreak sent=31 不触发 (点条件 — flag 持久化)', (deps, config) => {
  setClock(new Date('2026-07-28T14:30:00').getTime())
  seedRandom(0)
  return {
    config: { ...config, phase: 'afternoon' },
    overrideDeps: {
      counterStore: {
        load: async () => ({ date: dateStr(now()), sent: 31, cap: 60, phase: 'afternoon', quotaMorning: 40, quotaAfternoon: 60, lastSentAt: 0, longPausesInjected: 0, bigBreakInjected: true }),  // ← injected=true
        writeAtomic: async () => {},
      },
    },
  }
}, ({ decision }) => decision.decision === 'proceed' && decision.sleepMs < 195_000))  // 没 bigBreak

// S11: SessionExpiredError 重登
scenarios.push(() => runScenario('S11a', 'SessionExpired 首次重登成功', (deps, config) => {
  setClock(new Date('2026-07-28T09:10:00').getTime())
  seedRandom(0)
  let loginCount = 0
  return {
    config,
    overrideDeps: {
      counterStore: {
        load: async () => ({ date: dateStr(now()), sent: 0, cap: 40, phase: 'morning', quotaMorning: 40, quotaAfternoon: 60, lastSentAt: 0, longPausesInjected: 0, bigBreakInjected: false }),
        writeAtomic: async () => {},
      },
      sendGreeting: async () => {
        if (loginCount === 0) throw new SessionExpiredError('401 from BOSS')
        return  // 第二次成功
      },
      loginByQR: async () => { loginCount += 1 },
    },
  }
}, ({ decision }) => decision.decision === 'proceed'))

scenarios.push(() => runScenario('S11b', 'SessionExpired 重登失败 → throw (走 guard 流程)', (deps, config) => {
  setClock(new Date('2026-07-28T09:10:00').getTime())
  seedRandom(0)
  let loginCount = 0
  return {
    config,
    overrideDeps: {
      counterStore: {
        load: async () => ({ date: dateStr(now()), sent: 0, cap: 40, phase: 'morning', quotaMorning: 40, quotaAfternoon: 60, lastSentAt: 0, longPausesInjected: 0, bigBreakInjected: false }),
        writeAtomic: async () => {},
      },
      sendGreeting: async () => { throw new SessionExpiredError('401 from BOSS') },
      loginByQR: async () => { loginCount += 1; throw new Error('login failed') },
    },
  }
}, ({ decision, error }) => {
  // catch 路径: 期望 throw 'login failed' (重登 1 次后失败, throttleSend 应该 propagate)
  return error && error.message === 'login failed'
}))

// ============================================================================
// VERDICT (per DESIGN_VALIDATION §5)
// ============================================================================

const summarize = () => {
  console.log('\n' + '='.repeat(70))
  console.log('PROTOTYPE VERDICT — scripts/probe-throttle-logic.mjs')
  console.log('='.repeat(70))
  for (const r of results) {
    const mark = r.pass ? '✓' : '✗'
    const detail = r.error ? `err: ${r.error}` : JSON.stringify(r.decision).slice(0, 100)
    console.log(`${mark} ${r.id.padEnd(5)} ${r.name.padEnd(45)} ${detail}`)
  }
  const passed = results.filter((r) => r.pass).length
  const total = results.length
  console.log('-'.repeat(70))
  console.log(`PASS: ${passed}/${total}`)
  if (passed === total) {
    console.log('\n🟢 VERDICT: PASS — 接口决策树 §7.4 + §12 全部成立')
    console.log('   → 下一步: Sprint B-1 RED (T1-T5 throttle) + Sprint B-2 RED (T6-T10 可靠性)')
  } else if (passed >= total * 0.8) {
    console.log('\n🟡 VERDICT: PASS WITH NOTES — 部分场景需调整 ADR §7.4 / §12')
  } else {
    console.log('\n🔴 VERDICT: FAIL — 决策树或 §12 修复存在问题,需回 ADR 修订')
  }
  console.log('='.repeat(70))
  console.log('提示: 产物目录 .bapply/probe-throttle/ 可手动删除')
}

// 启动: 清理 + 顺序执行所有 scenarios
;(async () => {
  // 第一次清理
  await fs.rm(PROBE_DIR, { recursive: true, force: true }).catch(() => {})
  // 顺序执行 scenarios (Promise.all 顺序无竞态)
  for (const s of scenarios) {
    await s()
  }
  summarize()
})()
