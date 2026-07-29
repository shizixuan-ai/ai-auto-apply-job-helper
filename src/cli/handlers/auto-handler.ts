// ============================================================
// src/cli/handlers/auto-handler.ts — Sprint C-2a + D-1b + D-2a §14.5 + §16 GREEN
// ------------------------------------------------------------
// 状态: GREEN (Sprint C-2a + D-1b 已确认; D-2a RED 已确认 buildDefaultDeps is not function)
// 覆盖: ADR §14.5 C-2a (R1+R3+R6) + §16.3.2 D-1b (guard.onBlock + recordBlock)
//       + §16.3.1 D-2a (buildDefaultDeps 拼装 deps)
//   - D-2a: buildDefaultDeps: counterStore (fs) + accountMetaStore (fs) +
//     guard.onBlock (recordBlock + 连续 blocked 降档 + notifier) +
//     notifier (console) + 3 STUB (bossSearch/sendGreeting/loginByQR 抛 BOSSStubError)
//   - D-2a §3.9 防崩: guard.onBlock 内 recordBlock/regressWarmup 失败 → swallow + warn
// 纪律: §3.13 错误分层 (BOSSStubError.layer='STUB' + notifier msg [AUTO.guard]/[AUTO.stub]);
//       §3.9 错误传播 (guard.onBlock 内部 try/catch 不让外层崩);
//       §3.10 refactor: 新 export buildDefaultDeps, 现有 caller 0 改
// 单账号红线守住: 3 STUB 全 throw, 默认 fs store 不触碰 BOSS
// ============================================================

import {
  throttleSend,
  ThrottleError,
  type AutoConfig,
  type AccountMeta,
  type ThrottleDeps,
  type Job,
} from '../../auto/throttle'
import * as path from 'node:path'
import type { CounterStore } from '../../auto/counter-store'
import {
  createFsCounterStore,
} from '../../auto/counter-store'
import type { AccountMetaStore } from '../../auto/account-meta-store'
import {
  createFsAccountMetaStore,
} from '../../auto/account-meta-store'
import { GuardError, isGuardError, type GuardReason } from '../../auto/guard'
import { type SafetyConfig } from '../../auto/config-schema'

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

// ============================================================
// Sprint D-2a buildDefaultDeps (per §16.3.1 架构图 + §16.5 T26-T28)
// ------------------------------------------------------------
// 拼装 AutoHandlerDeps: counterStore (fs) + accountMetaStore (fs) +
// guard.onBlock (recordBlock + 连续 blocked 降档 + notifier) +
// notifier (console) + bossSearch/sendGreeting/loginByQR 全 STUB_THROW
// (单账号红线: D-2 不允许触碰 BOSS, 抛 stub 让 runDailyLoop 退 2 state=aborted)
// 纪律: §3.13 错误分层 (stub error 含 [AUTO.stub] 前缀);
//       §3.9 错误传播 (accountMetaStore.recordBlock 失败 → guard.onBlock 内部
//         try/catch swallow + notifier warn, 不让外层 buildDefaultDeps 崩);
//       §3.10 refactor: 新 export, 现有 caller 0 改
// 单账号红线守住: 3 STUB 全 throw 不触碰 BOSS
// ============================================================

/**
 * Stub error: D-2 暂未实现 bossSearch/sendGreeting/loginByQR 真 BOSS 调用.
 * 抛 stub 让 runDailyLoop 映射 exit 2 (R1 login failed → aborted).
 */
class BOSSStubError extends Error {
  readonly layer = 'STUB' as const  // per §3.13
  constructor(public op: 'bossSearch' | 'sendGreeting' | 'loginByQR') {
    super(`[AUTO.stub] ${op} 未接线 (D-2 单账号红线: 不触碰 BOSS), 后续 Sprint E 真账号模块替换`,)
    this.name = 'BOSSStubError'
  }
}

/** 默认 console notifier (per §3.13 layer 前缀) */
export const consoleNotifier: AutoNotifier = {
  async notify(level, msg) {
    const tag = level === 'critical' ? '🔴' : '🟡'
    console.log(`${tag} [${level.toUpperCase()}] ${msg}`)
  },
}

/**
 * 默认 guard.onBlock (per §16.3.2 时序图 buildDefaultDeps.guard):
 *   1. recordBlock(reason) 持久化 blockedHistory (try/catch swallow)
 *   2. consecutiveBlocks >= DEFAULT_SAFETY.consecutive_guard_threshold → regressWarmup
 *   3. notifier.notify('critical', `[AUTO.guard] ${reason}`)
 *
 * §3.9 防崩: recordBlock / regressWarmup 失败 → swallow + notifier warn,
 * 让 buildDefaultDeps.onBlock 不抛 (外层 runDailyLoop 不依赖 onBlock 抛错)
 */
function buildDefaultGuard(deps: {
  accountMetaStore: AccountMetaStore
  notifier: AutoNotifier
}): GuardCallback {
  const { accountMetaStore, notifier } = deps
  const threshold = DEFAULT_SAFETY_VALUE.consecutive_guard_threshold  // 3
  return {
    async onBlock(reason, error) {
      let currentTier: 'new' | 'warm' | 'old' | undefined
      try {
        const updated = await accountMetaStore.recordBlock(reason, error)
        currentTier = updated.currentTier
      } catch (e) {
        // §3.9 防崩: recordBlock 失败不阻断 onBlock (外层 runDailyLoop 期望 onBlock 静默)
        await notifier.notify(
          'warn',
          `[AUTO.guard] recordBlock 失败: ${(e as Error).message}`,
        )
        return
      }

      // 连续 blocked 阈值检查 (用 recordBlock 返回值判断最新 blockedHistory 长度)
      const blockedHistoryLen = (await safeLoadHistoryLen(accountMetaStore))
      if (blockedHistoryLen >= threshold) {
        try {
          const regressed = await accountMetaStore.regressWarmup()
          if (regressed.currentTier !== currentTier) {
            await notifier.notify(
              'critical',
              `[AUTO.guard] 连续 blocked ${blockedHistoryLen} 次 ≥ 阈值 ${threshold}, 自动降档 ${currentTier} → ${regressed.currentTier}`,
            )
          }
        } catch (e) {
          await notifier.notify(
            'warn',
            `[AUTO.guard] regressWarmup 失败: ${(e as Error).message}`,
          )
        }
      }

      // 主 critical 通知
      await notifier.notify(
        'critical',
        `[AUTO.guard] ${reason}${error ? `: ${error.message}` : ''}`,
      )
    },
  }
}

// DEFAULT_SAFETY 内联常量 (避免依赖 config-schema 类型, 减少 cross-module 耦合)
const DEFAULT_SAFETY_VALUE: SafetyConfig = {
  guard_trigger_policy: 'abort_day',
  max_failure_rate: 0.3,
  consecutive_guard_threshold: 3,
  auto_regress_warmup: true,
}

/** 安全读取 blockedHistory 长度 (失败返 0, 不抛) */
async function safeLoadHistoryLen(store: AccountMetaStore): Promise<number> {
  try {
    const meta = await store.load()
    return meta.blockedHistory?.length ?? 0
  } catch {
    return 0
  }
}

/** buildDefaultDeps opts (per §16.3.2 时序图) */
export interface BuildDefaultDepsOpts {
  /** 配置目录 (默认 ~/.bapply/, 用于 fs counter + account-meta 路径) */
  configDir: string
  /** loadAutoConfig 返回的 config */
  config: AutoConfig
  /** accountMetaStore.load() 返回的 meta (作为 AutoHandlerDeps.accountMeta 注入) */
  accountMeta: AccountMeta
  /** 自定义 notifier (默认 console) */
  notifier?: AutoNotifier
  /** 自定义 accountMetaStore factory (默认 createFsAccountMetaStore(configDir + '/account-meta.json')) */
  accountMetaStoreFactory?: (configDir: string) => AccountMetaStore
  /** 自定义 counterStore factory (默认 createFsCounterStore(configDir + '/counter.json')) */
  counterStoreFactory?: (configDir: string) => CounterStore
  /** 自定义 guard (默认 buildDefaultGuard, T26/T27 测试可注) */
  guard?: GuardCallback
  /** 自定义 now() (默认 () => Date.now()) */
  now?: () => number
  /** 自定义 rand() (默认 () => Math.random()) */
  rand?: () => number
  /** D-1b 缺口 6: 严格退出码 (透传给 deps.strictExitCode) */
  strictExitCode?: boolean
}

/**
 * buildDefaultDeps: 拼装 AutoHandlerDeps (per §16.3.1 架构图).
 * 默认全用 fs factory + console notifier + 默认 guard + 3 STUB.
 *
 * @example
 *   const deps = await buildDefaultDeps({
 *     configDir: '~/.bapply',
 *     config,
 *     accountMeta,
 *   })
 *   const result = await runDailyLoop(deps, '2026-07-29')
 */
export async function buildDefaultDeps(
  opts: BuildDefaultDepsOpts,
): Promise<AutoHandlerDeps> {
  const configDir = opts.configDir
  const accountMetaStore = opts.accountMetaStoreFactory
    ? opts.accountMetaStoreFactory(configDir)
    : createFsAccountMetaStore(path.join(configDir, 'account-meta.json'))
  const counterStore = opts.counterStoreFactory
    ? opts.counterStoreFactory(configDir)
    : createFsCounterStore(path.join(configDir, 'counter.json'))
  const notifier = opts.notifier ?? consoleNotifier
  const guard = opts.guard ?? buildDefaultGuard({
    accountMetaStore,
    notifier,
    // 默认用 safety 默认值 (D-1a DEFAULT_SAFETY, threshold=3)
    // 注: runDailyLoop 内部 failureRateThreshold 仍用 deps.failureRateThreshold ?? 0.3 (R3)
  })

  return {
    // 必填 (per C-2a AutoHandlerDeps)
    now: opts.now ?? (() => Date.now()),
    rand: opts.rand ?? (() => Math.random()),
    bossSearch: async (_date: string) => {
      throw new BOSSStubError('bossSearch')
    },
    counterStore,
    sendGreeting: async (_job: Job) => {
      throw new BOSSStubError('sendGreeting')
    },
    loginByQR: async () => {
      throw new BOSSStubError('loginByQR')
    },
    notifier,
    accountMeta: opts.accountMeta,
    config: opts.config,
    // 可选 (per D-1b)
    accountMetaStore,
    guard,
    strictExitCode: opts.strictExitCode ?? false,
  }
}