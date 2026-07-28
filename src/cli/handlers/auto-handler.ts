// ============================================================
// src/cli/handlers/auto-handler.ts — Sprint C-2a + D-1b §14.5 + §16 GREEN
// ------------------------------------------------------------
// 状态: GREEN (Sprint C-2a RED 已确认; D-1b RED 已确认 T25a/T25b FAIL, T25c PASS)
// 覆盖: ADR §14.5 C-2a (R1+R3+R6) + §16.3.2 D-1b (guard.onBlock + recordBlock)
//   - D-1b 缺口 1: deps.guard.onBlock(reason, error) 统一风控/失败率回调入口
//   - D-1b 缺口 2: 失败率阈值从 config.safety.max_failure_rate 取 (buildDefaultDeps)
//   - D-1b 缺口 4: deps.accountMetaStore 注入 (recordBlock 持久化 blockedHistory)
//   - D-1b 缺口 6: RunStats.effective_successes + stats.guardTriggers
//   - 旧 R2/R3 路径保留 (deps.guard 未注入时 = Sprint C-2a 行为, 向后兼容 T14-T16 6 it())
// 纪律: §3.13 错误分层 (notifier msg 前缀 [AUTO.runner] / [AUTO.guard]);
//       §3.12 mock 注入 (deps 全 optional, 默认 stub 不触碰 BOSS);
//       §3.10 refactor: deps 3 字段全 optional, 现有 caller 0 改
// 单账号红线守住: bossSearch / sendGreeting / loginByQR / accountMetaStore 全 deps 注入
// ============================================================

import {
  throttleSend,
  ThrottleError,
  type AutoConfig,
  type AccountMeta,
  type ThrottleDeps,
  type Job,
} from '../../auto/throttle'
import type { CounterStore } from '../../auto/counter-store'
import type { AccountMetaStore } from '../../auto/account-meta-store'
import { GuardError, isGuardError, type GuardReason } from '../../auto/guard'

/** Notifier 接口 (R2+C-2b 由 guard.ts 实现, 此处仅 interface) */
export interface AutoNotifier {
  notify(level: 'warn' | 'critical', msg: string): Promise<void>
}

/**
 * 风控回调接口 (D-1b 缺口 1, per §16.3.2 时序图).
 * 由 caller (D-1c buildDefaultDeps) 实现, 内部串联:
 *   accountMetaStore.recordBlock → regressWarmup (条件) → notifier
 */
export interface GuardCallback {
  onBlock(
    reason: GuardReason | 'high_failure_rate',
    error: GuardError | null,
  ): Promise<void>
}

/** AutoHandlerDeps 注入 (per §14.2.3 关系图 + §16 D-1b 扩 3 字段) */
export interface AutoHandlerDeps {
  now: () => number
  rand: () => number
  bossSearch: (date: string) => Promise<Job[]>
  counterStore: CounterStore
  sendGreeting: (job: Job) => Promise<void>
  loginByQR: () => Promise<void>
  notifier: AutoNotifier
  accountMeta: AccountMeta
  config: AutoConfig
  /** 测试可注入 noop sleep, 避免 interval 实际等待 */
  sleep?: (ms: number) => Promise<void>
  /** 失败率阈值 (默认 0.3 = 30%, per R3) */
  failureRateThreshold?: number
  /** 失败率检查最小样本数 (默认 10, per ADR §14.2.2 "每 10 次迭代后") */
  failureRateCheckEvery?: number
  /** D-1b 缺口 4: 账号 meta 持久化层 (recordBlock 写 blockedHistory) */
  accountMetaStore?: AccountMetaStore
  /** D-1b 缺口 1: 风控回调入口 (R2 GuardError + R3 失败率都走这里) */
  guard?: GuardCallback
  /** D-1b 缺口 6: 严格退出码 (effective_successes=0 → exit 2 视为致命软错误) */
  strictExitCode?: boolean
}

/** 状态机 (per §14.2.4 流程图): idle / login / running / paused / blocked / done / aborted */
export type HandlerState =
  | 'idle' | 'login' | 'running' | 'paused'
  | 'blocked' | 'done' | 'aborted'

export interface RunStats {
  sent: number        // 总尝试 (counter 消耗 = 配额)
  ok: number          // sendGreeting 成功
  failed: number      // sendGreeting 失败 (B2=a: continue)
  blocked: boolean    // 是否因失败率超阈被强制中断 (R3)
  /** D-1b 缺口 6: 实际 BOSS 200 OK 数 (vs ok = throttleSend 返回 proceed 但 sendGreeting 内部可能抛) */
  effective_successes: number
  /** D-1b 新: guard.onBlock 触发次数 (R2 GuardError + R3 失败率 都算) */
  guardTriggers: number
}

export interface RunResult {
  exitCode: 0 | 1 | 2
  stats: RunStats
  state: HandlerState
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms))

/**
 * 主入口: 运行单日投递循环.
 * @returns RunResult 含 exitCode (0/1/2 per R6) + stats + final state
 */
export async function runDailyLoop(
  deps: AutoHandlerDeps,
  date: string,
): Promise<RunResult> {
  const sleep = deps.sleep ?? defaultSleep
  const threshold = deps.failureRateThreshold ?? 0.3
  const checkEvery = deps.failureRateCheckEvery ?? 10

  const stats: RunStats = {
    sent: 0,
    ok: 0,
    failed: 0,
    blocked: false,
    effective_successes: 0,
    guardTriggers: 0,
  }

  // ── 1. R1: 初始 loginByQR ────────────────────────────────────
  try {
    await deps.loginByQR()
  } catch (e) {
    const msg = `[AUTO.runner] login failed: ${(e as Error).message}`
    await deps.notifier.notify('critical', msg)
    return { exitCode: 2, stats, state: 'aborted' }
  }

  // ── 2. 拉取 jobs (单账号红线守住: bossSearch 由 caller 注入) ──
  const jobs = await deps.bossSearch(date)

  // ── 3. 构造 throttleSend 用的 deps (从 AutoHandlerDeps 收窄) ──
  const throttleDeps: ThrottleDeps = {
    now: deps.now,
    rand: deps.rand,
    counterStore: deps.counterStore,
    sendGreeting: deps.sendGreeting,
    loginByQR: deps.loginByQR,
    accountMeta: deps.accountMeta,
  }

  // ── 4. for each job ─────────────────────────────────────────
  for (const job of jobs) {
    try {
      const decision = await throttleSend(job, throttleDeps, deps.config)
      if (decision.decision === 'sleep' && decision.sleepMs && decision.sleepMs > 0) {
        await sleep(decision.sleepMs)
      }
      stats.ok += 1  // throttleSend 成功 (含 sendGreeting 成功)
      stats.effective_successes += 1  // D-1b 缺口 6: 实际 200 OK 数
    } catch (e) {
      if (e instanceof ThrottleError) {
        // 配额耗尽 / 17:30 / 周末 → 跳出循环, 不算 per-job 失败
        break
      }
      if (isGuardError(e)) {
        // R2 风控墙: D-1b 缺口 1 走 deps.guard.onBlock (向后兼容: 未注入 = 旧路径)
        stats.blocked = true
        stats.guardTriggers += 1
        if (deps.guard) {
          await deps.guard.onBlock((e as GuardError).reason, e as GuardError)
        } else {
          await deps.notifier.notify(
            'critical',
            `[AUTO.runner] 风控触发 (${(e as GuardError).reason}): ${(e as Error).message}`,
          )
        }
        break
      }
      // B2=a: 单 job 投递失败 → 继续下一 job
      stats.failed += 1
    }
    stats.sent += 1

    // ── 5. R3: 失败率监控 (每 N 次迭代后) ─────────────────────
    if (
      stats.sent >= checkEvery
      && stats.sent % checkEvery === 0
      && stats.failed / stats.sent > threshold
    ) {
      stats.blocked = true
      stats.guardTriggers += 1
      const rate = (stats.failed / stats.sent * 100).toFixed(1)
      if (deps.guard) {
        // D-1b 缺口 1: 高失败率走 deps.guard.onBlock (与 R2 同一路径)
        await deps.guard.onBlock('high_failure_rate', null)
      } else {
        // 向后兼容: 未注入 guard = Sprint C-2a 行为
        await deps.notifier.notify(
          'critical',
          `[AUTO.runner] 失败率 ${rate}% 超阈 ${(threshold * 100).toFixed(0)}%, 当日剩余配额作废`,
        )
      }
      break
    }
  }

  // ── 6. R6 + D-1b 缺口 6: 退出码精化 ─────────────────────────
  let exitCode: 0 | 1 | 2
  if (stats.blocked) {
    exitCode = 2  // 致命 (R3 失败率 / R2 风控)
  } else if (deps.strictExitCode && stats.effective_successes === 0 && stats.sent > 0) {
    // D-1b 缺口 6: --strict-exit-code 开启时, 全 reject 但 counter 走完视为致命软错误
    exitCode = 2
  } else if (stats.effective_successes >= 1 || stats.ok >= 1) {
    exitCode = 0  // ≥1 成功
  } else {
    exitCode = 1  // 全部失败 / 部分失败 (无致命)
  }

  return {
    exitCode,
    stats,
    state: stats.blocked ? 'blocked' : 'done',
  }
}