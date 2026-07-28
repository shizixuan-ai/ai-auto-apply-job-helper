// ============================================================
// src/auto/throttle.ts — Sprint B-1 §7.4 决策树 + §12 修复
// ------------------------------------------------------------
// 状态: 骨架 (RED 阶段 per §4.1)
// ADR-0016 §7.4: 流程图 8 节点决策树
// ADR-0016 §12:  3 个可靠性补丁 (Sprint B-1 仅 §12 涉及 throttle 主逻辑的
//                部分 = weekend + 17:30; Issue 1-3 完整链路在 Sprint B-2)
// 纪律:   §3.13 错误分层 (this.layer='THROTTLE'); §3.5 4 类图已画在 ADR §7
// ============================================================

// ─── Types ──────────────────────────────────────────────────

export type ThrottleErrorCode =
  | 'DailyDone'      // §7.4: now > 17:30
  | 'DailyLimit'     // §7.4: daily.sent >= cap
  | 'WeeklyLimit'    // §7.4: weekly.sent >= wkCap
  | 'WeekendBlock'   // §7.4: Sat/Sun

export class ThrottleError extends Error {
  readonly layer = 'THROTTLE' as const  // per §3.13
  constructor(
    message: string,
    public code: ThrottleErrorCode,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'ThrottleError'
  }
}

/**
 * §12 Issue 3: BOSS 服务端 session 过期 (401 或 "未登录" 响应) 时抛出.
 * throttleSend 捕获此错误后调 loginByQR 重登 1 次.
 * @see session-detector.ts (后续 Sprint B-2 真实 BOSS 响应探测)
 */
export class SessionExpiredError extends Error {
  readonly layer = 'SEND' as const  // per §3.13
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'SessionExpiredError'
  }
}

export type ThrottleDecisionKind = 'proceed' | 'sleep'

export interface ThrottleDecision {
  decision: ThrottleDecisionKind
  sleepMs?: number
  reason: string
}

export interface DailyCounter {
  date: string                          // "2026-07-28"
  sent: number
  cap: number                           // warmup 调整后的当日上限
  phase: 'morning' | 'afternoon'
  quotaMorning: number
  quotaAfternoon: number
  lastSentAt: number
  longPausesInjected: number
  bigBreakInjected: boolean             // §12 Issue 2
}

export interface WarmupTier {
  dayStart: number
  cap: number
}

export interface AccountMeta {
  registeredAt: number
  accountAgeDays: number
  baseDailyCap: number
  targetDailyCap: number
  weeklyCap: number
  warmupSchedule: WarmupTier[]
}

export interface QuotaConfig {
  morning: number
  afternoon: number
  weekly_cap: number
}

export interface ThrottleSettings {
  morning_interval_ms: [number, number]
  afternoon_interval_ms: [number, number]
  jitter_pct: number
  long_pause: { every_n_jobs: number; duration_ms: [number, number] }
  afternoon_mid_break: { after_job: number; duration_ms: [number, number] }
}

export interface AutoConfig {
  dryRun: boolean
  phase: 'morning' | 'afternoon'
  quota: QuotaConfig
  throttle: ThrottleSettings
  /** Sprint B-2 §12 Issue 1 step 4: SIGTERM handler 安装开关 (测试用) */
  installSignal?: boolean
}

export interface Job {
  id: string
  // ... 其它字段 (encryptedId, brandName, ...) 暂留 TBD
}

export interface ThrottleDeps {
  now: () => number
  rand: () => number                     // [0, 1)
  counterStore: {
    load: (date: string) => Promise<DailyCounter | null>
    writeAtomic: (counter: DailyCounter) => Promise<void>
  }
  sendGreeting?: (job: Job) => Promise<void>           // §12 Issue 1+3
  loginByQR?: () => Promise<void>                      // §12 Issue 3
  accountMeta: AccountMeta
}

// ─── 入口 ──────────────────────────────────────────────────

/**
 * 根据 ADR-0016 §7.4 流程图 + §12 修复, 决定本 job 是否可投递、sleep 多久或 abort.
 * @throws ThrottleError  当决策是 abort (DailyDone / DailyLimit / WeekendBlock / WeeklyLimit)
 * @returns ThrottleDecision  proceed 或 sleep
 */
export async function throttleSend(
  job: Job,
  deps: ThrottleDeps,
  config: AutoConfig,
): Promise<ThrottleDecision> {
  // 1. 时间归零
  const t = deps.now()
  const date = dateStr(t)
  const dayStart = todayStart(t)
  const msSinceDayStart = t - dayStart

  // 2. §7.4 节点 1: now > 17:30 → DailyDone
  if (msSinceDayStart > ACTIVE_END_MS) {
    throw new ThrottleError(`daily_done(now>17:30)`, 'DailyDone')
  }

  // 3. §7.4 节点 2: 11:30 ≤ now < 14:00 → lunch_break sleep until 14:00
  if (msSinceDayStart >= ACTIVE_MORNING_END_MS && msSinceDayStart < ACTIVE_AFTERNOON_START_MS) {
    const sleepMs = (dayStart + ACTIVE_AFTERNOON_START_MS) - t
    return {
      decision: 'sleep',
      sleepMs,
      reason: 'lunch_break(11:30-14:00 sleep until 14:00)',
    }
  }

  // 4. §7.4 节点 3: weekend block (dry-run pass)
  if (isWeekend(t)) {
    if (config.dryRun) {
      return { decision: 'proceed', reason: 'weekend_dry_run' }
    }
    throw new ThrottleError('weekend_block', 'WeekendBlock')
  }

  // 5. counter load (or init with warmup cap)
  let counter = await deps.counterStore.load(date)
  if (!counter) {
    counter = initCounter(date, deps.accountMeta, config)
  }

  // 6. §7.4 节点 4: daily cap
  if (counter.sent >= counter.cap) {
    throw new ThrottleError(
      `daily_cap(sent=${counter.sent}>=cap=${counter.cap})`,
      'DailyLimit',
    )
  }

  // 7. §7.4 节点 5: weekly cap (Sprint B-1 简化: counter.sent 作 proxy; Sprint B-2 切 weeklyCounter)
  if (counter.sent >= config.quota.weekly_cap) {
    throw new ThrottleError(
      `weekly_cap(sent=${counter.sent}>=wkCap=${config.quota.weekly_cap})`,
      'WeeklyLimit',
    )
  }

  // 8. compute interval + jitter
  const intervalRange = config.phase === 'morning'
    ? config.throttle.morning_interval_ms
    : config.throttle.afternoon_interval_ms
  const baseInterval = randomInRange(intervalRange, deps.rand)
  const jitterSign = deps.rand() < 0.5 ? -1 : 1
  const jitter = baseInterval * (config.throttle.jitter_pct / 100) * jitterSign
  let intervalMs = baseInterval + jitter

  // 9. §7.4 节点 6: longPause (sent % 20 == 0 && sent > 0)
  const longPause = config.throttle.long_pause
  if (
    longPause
    && counter.sent > 0
    && counter.sent % longPause.every_n_jobs === 0
    && counter.sent < counter.cap
  ) {
    intervalMs += randomInRange(longPause.duration_ms, deps.rand)
    counter.longPausesInjected += 1  // 内存态; Sprint B-2 持久化
  }

  // 10. §12 Issue 2: bigBreak 点条件 (sent === 30 && !injected)
  const bigBreak = config.throttle.afternoon_mid_break
  if (
    bigBreak
    && counter.sent === bigBreak.after_job
    && !counter.bigBreakInjected
    && counter.sent < counter.cap
  ) {
    intervalMs += randomInRange(bigBreak.duration_ms, deps.rand)
    counter.bigBreakInjected = true  // 内存态; Sprint B-2 持久化
  }

  // 11. §12 Issue 1: counter++ 先于 sendGreeting (顺序倒置: 宁可少发不可重复)
  counter.sent += 1
  counter.lastSentAt = deps.now()
  await deps.counterStore.writeAtomic(counter)

  // 12. §12 Issue 3: sendGreeting + SessionExpiredError 重试 1 次
  if (deps.sendGreeting) {
    let retried = false
    while (true) {
      try {
        await deps.sendGreeting(job)
        break
      } catch (e) {
        if (e instanceof SessionExpiredError && !retried && deps.loginByQR) {
          await deps.loginByQR()  // 重登 1 次
          retried = true
          continue
        }
        // 其他错误或重登失败: propagate (counter 仍 +1, 配额消耗但不重复)
        throw e
      }
    }
  }

  // 13. §12 Issue 1 step 4: SIGTERM handler 落盘 (测试用 installSignal 选项)
  if (config.installSignal) {
    process.removeAllListeners('SIGTERM')  // 去重, 避免多测试泄漏
    process.on('SIGTERM', async () => {
      try {
        await deps.counterStore.writeAtomic(counter)
      } catch (e) {
        console.error('[THROTTLE] SIGTERM flush failed:', e)
      }
      // 不调 process.exit: 让 process manager (cron / npm) 决定何时终止
      // 测试场景: 直接 invoke handler 验证 flush, 不触发退出
    })
  }

  // 14. 主路径: proceed with sleepMs (caller 实际 await sleepMs 后投递)
  return {
    decision: 'proceed',
    sleepMs: Math.max(0, intervalMs),
    reason: `proceed(sent=${counter.sent}/${counter.cap})`,
  }
}

// ─── Helper exports (GREEN 阶段内部用, RED 阶段导出以便测试) ──

export const ACTIVE_MORNING_END_MS = 11.5 * 3600 * 1000       // 11:30
export const ACTIVE_AFTERNOON_START_MS = 14 * 3600 * 1000    // 14:00
export const ACTIVE_END_MS = 17.5 * 3600 * 1000              // 17:30

export function todayStart(nowMs: number): number {
  const d = new Date(nowMs)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export function dateStr(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10)
}

export function isWeekend(nowMs: number): boolean {
  const dow = new Date(nowMs).getDay()
  return dow === 0 || dow === 6
}

export function warmupCap(meta: AccountMeta, config: AutoConfig): number {
  let cap = meta.baseDailyCap
  for (const tier of meta.warmupSchedule) {
    if (meta.accountAgeDays >= tier.dayStart) cap = tier.cap
  }
  return Math.min(cap, config.quota.morning + config.quota.afternoon)
}

export function initCounter(
  date: string,
  accountMeta: AccountMeta,
  config: AutoConfig,
): DailyCounter {
  return {
    date,
    sent: 0,
    cap: warmupCap(accountMeta, config),
    phase: config.phase,
    quotaMorning: config.quota.morning,
    quotaAfternoon: config.quota.afternoon,
    lastSentAt: 0,
    longPausesInjected: 0,
    bigBreakInjected: false,
  }
}

/** 在 [min, max] 范围内均匀采样 (含 min, 不含 max) */
export function randomInRange(range: [number, number], rand: () => number): number {
  return range[0] + rand() * (range[1] - range[0])
}
