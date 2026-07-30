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
  type AutoConfig as ThrottleAutoConfig,
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
import { type SafetyConfig, type AutoConfig as SchemaAutoConfig } from '../../auto/config-schema'
import { createInMemoryCounterStore } from '../../auto/counter-store'
import {
  createFeishuNotifier,
  type FeishuNotifierOpts,
} from '../../auto/feishu-notifier'

// ============================================================
// Sprint E-3.1+E-3.2 真接 — 加真模块 import
// ============================================================
// 注意: browser module 顶层会 import config/index.ts (loadConfig -> dotenv),
// 必须 dotenv 已 inject (bapply.js 顶层 import 'dotenv/config' 锁住).
// ============================================================
import {
  hasAuthToken,
  loginByQR as browserLoginByQR,
  createBrowserSession,
  createCDPSession,
  closeBrowserSession,
  searchJobs as browserSearchJobs,
  fetchJobDetail as browserFetchJobDetail,
} from '../../browser/index.js'
import { runSearchAndWrite, type PassingJob } from './search-and-write.js'
import { runSendCommand, type SendCommandOptions, type SendCommandDeps, type SendCommandResult } from './send-handler.js'
import { resolveResume } from '../../resume/resolver.js'
import { scoreJob } from '../../scoring/index.js'
import { createRecord as feishuCreateRecord, updateRecord as feishuUpdateRecord } from '../../feishu/index.js'
import { createLLM } from '../../llm/index.js'
import { loadConfig } from '../../config/index.js'

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
  config: ThrottleAutoConfig
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

/**
 * Sprint E-3.3: extend Job 类型加 recordId (bossSearch 写飞书后注入).
 *   - 用 intersection 替代 cast (per memory feedback_type_cast_design_gap.md)
 *   - 类型上: AutoJob = Job & { recordId?: string; lid?: string; securityId?: string }
 *   - 单 sendGreeting 用 AutoJob 即可 (throttle 路径不读 recordId, 只用 id)
 */
export type AutoJob = Job & {
  /** 写飞书后注入; sendGreeting 用它更新飞书状态 */
  recordId?: string
  /** BOSS list-context lid (来自 SearchResult, send 必传) */
  lid?: string
  /** BOSS 风控 token securityId (来自 SearchResult, send 必传) */
  securityId?: string
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
  /**
   * D-3 §17.12 修正 3: 退出码扩展为 0|1|2|3
   * - 0 = success (≥1 effective_successes)
   * - 1 = partial failure (无 blocked, effective_successes > 0 但 < sent)
   * - 2 = fatal/aborted (login failed / config error / strictExitCode 触发全 reject)
   * - 3 = blocked (R2 GuardError / R3 失败率超阈, 可恢复, 不需人工)
   */
  exitCode: 0 | 1 | 2 | 3
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
  // Sprint E-3.x 回归修复: dryRun STUB throw BOSSStubError → R1 退出码 2 (aborted)
  //  duck-type 识别 BOSSStubError (class 未 export per §3.10/§3.13)
  let jobs: Job[] = []
  try {
    jobs = await deps.bossSearch(date)
  } catch (e) {
    const err = e as Error & { name?: string; layer?: string }
    if (err?.name === 'BOSSStubError' && err?.layer === 'STUB') {
      await deps.notifier.notify('critical', `[AUTO.runner] bossSearch stub: ${err.message}`)
      return { exitCode: 2, stats, state: 'aborted' }
    }
    throw e
  }

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

  // ── 6. R6 + D-1b 缺口 6 + D-3 §17.12 修正 3: 退出码精化 ─────────
  let exitCode: 0 | 1 | 2 | 3
  if (stats.blocked) {
    // D-3 §17.12 修正 3: 风控触发 → exit 3 (可恢复, 不需人工)
    // 区别于 fatal exit 2 (login failed / config error)
    exitCode = 3
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
 *   2. consecutiveBlocks >= threshold (config.safety ?? DEFAULT_SAFETY) → regressWarmup
 *   3. notifier.notify('critical', `[AUTO.guard] ${reason}`)
 *
 * D-3 §17.12 修正 1: threshold 优先级 = config.safety?.x ?? DEFAULT_SAFETY.x
 * §3.9 防崩: recordBlock / regressWarmup 失败 → swallow + notifier warn,
 * 让 buildDefaultDeps.onBlock 不抛 (外层 runDailyLoop 不依赖 onBlock 抛错)
 */
function buildDefaultGuard(deps: {
  accountMetaStore: AccountMetaStore
  notifier: AutoNotifier
  /** D-3 §17.12 修正 1: 用户 YAML 配的 safety (优先级最高) */
  safety?: SafetyConfig
}): GuardCallback {
  const { accountMetaStore, notifier, safety } = deps
  // D-3 §17.12 修正 1: 用户 safety.xxx 优先, 缺字段 fallback DEFAULT_SAFETY_VALUE
  const threshold = safety?.consecutive_guard_threshold
    ?? DEFAULT_SAFETY_VALUE.consecutive_guard_threshold
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
  /**
   * loadAutoConfig 返回的 config (D-3 扩展: SchemaAutoConfig + dryRun/phase).
   * 含 schema 字段 (version/searches/quota/throttle/safety/notifier) + CLI 合并字段 (dryRun/phase).
   * notifier 已被 CLI 层 mergeWebhookFromEnv 处理过 (env var 优先覆盖 yaml).
   */
  config: SchemaAutoConfig & { dryRun: boolean; phase: 'morning' | 'afternoon' }
  /** accountMetaStore.load() 返回的 meta (作为 AutoHandlerDeps.accountMeta 注入) */
  accountMeta: AccountMeta
  /** 显式注入 notifier (测试 / 手动 override; 优先级最高) */
  notifier?: AutoNotifier
  /** 自定义 accountMetaStore factory (默认 createFsAccountMetaStore(configDir + '/account-meta.json')) */
  accountMetaStoreFactory?: (configDir: string) => AccountMetaStore
  /** 自定义 counterStore factory (默认 createFsCounterStore(configDir + '/counter.json')) */
  counterStoreFactory?: (configDir: string) => CounterStore
  /** 自定义 guard (默认 buildDefaultGuard, T26/T27 测试可注) */
  guard?: GuardCallback
  /** 自定义 notifier factory (E-1b 测试可注; 默认 createFeishuNotifier) */
  notifierFactory?: (opts: FeishuNotifierOpts) => AutoNotifier
  /** 自定义 now() (默认 () => Date.now()) */
  now?: () => number
  /** 自定义 rand() (默认 () => Math.random()) */
  rand?: () => number
  /** D-1b 缺口 6: 严格退出码 (透传给 deps.strictExitCode) */
  strictExitCode?: boolean
  /** E-3.1: CDP 开关 (默认 false = stealth launch); CLI 层透传 program.opts().cdp */
  cdp?: boolean
  /**
   * E-3.2/E-3.3: 注入完整 deps 给真模块链.
   * test/manual 可提供 mock; 默认走生产实现 (load config + createLLM + 真 feishu).
   *
   * 字段:
   *   - autoConfig: AutoConfig + dryRun/phase (同 opts.config)
   *   - appToken / tableId: 飞书多维表格 appToken/tableId; dryRun 时可空
   *   - feishu.createRecord / updateRecord: 飞书写入的工厂 (默认 = 真 feishu)
   *   - llm: LLM 实例 (默认 createLLM(loadConfig())); dryRun 时可 noop
   *   - scoreThreshold: 评分阈值 (默认 SCORE_THRESHOLD env → 60); noThreshold=true 时忽略
   *   - noThreshold: 不阈值过滤 (所有 scored 都算 passed)
   */
  autoDeps?: AutoDeps
}

/**
 * E-3.2/E-3.3 注入式依赖 (test 可换, 默认走真实现).
 * 把这些抽出来避免 buildDefaultDeps opts 字段爆炸.
 */
export interface AutoDeps {
  /** AppToken/tableId: 缺一 → bossSearch/sendGreeting 降级 noop (单账号红线 dry-run) */
  appToken?: string
  tableId?: string
  /** 飞书写入 (createRecord / updateRecord). 默认 = 真 feishu.createRecord/updateRecord */
  createRecord?: (fields: any) => Promise<{ record_id: string }>
  updateRecord?: (recordId: string, fields: any) => Promise<any>
  /** LLM 实例 (默认 createLLM(loadConfig())) */
  llm?: unknown
  /** 评分阈值 (默认 SCORE_THRESHOLD env → 60) */
  scoreThreshold?: number
  /** 是否忽略阈值 (默认 false) */
  noThreshold?: boolean
  /** CDP 开关 (单 cron 场景默认 false) */
  cdp?: boolean
}

/**
 * E-1b: CLI 层 env 合并工具. 把 process.env.FEISHU_WEBHOOK_URL (如设)
 * 覆盖到 config.notifier.webhookUrl, 其余 4 字段保留 YAML.
 * 返回新 config (不变异) — 简化 buildDefaultDeps 探测为 2 层.
 *
 * @param config    loadAutoConfig 返回的 config
 * @param envUrl    process.env.FEISHU_WEBHOOK_URL (CLI 探测后传入)
 * @returns         新 config (env 设了 → notifier.webhookUrl 覆盖; env 没设 → 原 config)
 */
export function mergeWebhookFromEnv(
  config: SchemaAutoConfig,
  envUrl: string | undefined,
): SchemaAutoConfig {
  if (!envUrl) return config
  return {
    ...config,
    notifier: {
      ...config.notifier,
      webhookUrl: envUrl,
    },
  }
}

/**
 * buildDefaultDeps: 拼装 AutoHandlerDeps (per §16.3.1 架构图).
 * 默认全用 fs factory + console notifier + 默认 guard + 3 STUB.
 *
 * **E-1b 简化探测** (per 架构师 review): 仅 2 层 source —
 *   1. opts.notifier 显式注入 (测试 / manual override, 优先级最高)
 *   2. config.notifier.webhookUrl 存在 → factory (默认 createFeishuNotifier) 4 字段全透传
 *   3. fallback → consoleNotifier
 *
 * CLI 层应在调用前用 mergeWebhookFromEnv 把 env var 合并进 config.notifier.webhookUrl.
 *
 * @example
 *   const configWithEnv = mergeWebhookFromEnv(config, process.env.FEISHU_WEBHOOK_URL)
 *   const deps = await buildDefaultDeps({
 *     configDir: '~/.bapply',
 *     config: { ...configWithEnv, dryRun: false, phase: 'morning' },
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
  // D-3 §17.12 修正 2: dry-run 用 in-memory counter, 不污染 fs (避免真账号接入后配额被 dry-run 消耗)
  const counterStore = opts.config.dryRun
    ? createInMemoryCounterStore()
    : opts.counterStoreFactory
      ? opts.counterStoreFactory(configDir)
      : createFsCounterStore(path.join(configDir, 'counter.json'))
  // E-1b 简化探测 (per 架构师 review): 2 层 source + fallback
  // 探测顺序: opts.notifier (1, test/manual 显式) > factory with 4 字段透传 (2) > consoleNotifier (3)
  const notifier = resolveNotifier(opts)
  // D-3 §17.12 修正 1: 透传 config.safety 给 guard (用户 YAML 优先级最高)
  const guard = opts.guard ?? buildDefaultGuard({
    accountMetaStore,
    notifier,
    safety: opts.config.safety,  // 用户配的 safety 优先, 缺字段 fallback DEFAULT_SAFETY
  })

  // ============================================================
  // Sprint E-3.1/E-3.2/E-3.3: 构造真模块注入
  // dryRun 模式: 3 STUB 全 throw (per §17.12.3 单账号红线 dry-run 不触碰 BOSS)
  // 真发模式: 走 defaultLoginByQR / defaultBossSearch / defaultSendGreeting
  // ============================================================
  const isDryRun = opts.config.dryRun
  const cdp = opts.cdp ?? opts.autoDeps?.cdp ?? false

  return {
    // 必填 (per C-2a AutoHandlerDeps)
    now: opts.now ?? (() => Date.now()),
    rand: opts.rand ?? (() => Math.random()),
    bossSearch: isDryRun
      ? async (_date: string) => { throw new BOSSStubError('bossSearch') }
      : await defaultBossSearch(opts),
    counterStore,
    sendGreeting: isDryRun
      ? async (_job: Job) => { throw new BOSSStubError('sendGreeting') }
      : await defaultSendGreeting(opts),
    // E-3.1: 真接 loginByQR — cookies 兜底 (per user 决策: 每次 auto 启动打开浏览器一次)
    //   - dryRun: noop
    //   - 真发: createSession → hasAuthToken → loginByQR(page) → closeSession
    //   - 错误 throw → runDailyLoop:138 接住 → notifier.critical + state=aborted
    loginByQR: isDryRun
      ? async () => { /* dryRun noop, runDailyLoop 不会真调到这里 */ }
      : async () => { await defaultLoginByQR(cdp) },
    notifier,
    accountMeta: opts.accountMeta,
    // D-3 §17.12: SchemaAutoConfig + dryRun/phase → throttle AutoConfig (throttle 不读 safety)
    // cast 是单向的: safety 是 additive 字段, 不影响 throttle 行为
    config: opts.config as unknown as ThrottleAutoConfig,
    // 可选 (per D-1b)
    accountMetaStore,
    guard,
    strictExitCode: opts.strictExitCode ?? false,
  }
}

// ============================================================
// Sprint E-3.1: defaultLoginByQR — cookies 兜底
// ============================================================

/**
 * 默认 loginByQR 实现 (per user 决策).
 * 时序: createSession → hasAuthToken?(是)→return / (否)→loginByQR(page) → closeSession.
 * 错误 throw 上层 runDailyLoop (auto-handler:138-143) 接住 → notifier.critical + state=aborted.
 */
async function defaultLoginByQR(cdp: boolean): Promise<void> {
  // §3.13 错误 origin 必须带 layer
  const createSession = cdp
    ? () => createCDPSession()
    : () => createBrowserSession(false)
  const session = await createSession()
  try {
    // 1. 探测 cookies 是否仍有效 (49h 探测已确认 VALID)
    if (await hasAuthToken(session.page)) {
      console.log('ℹ️  [AUTO.login] cookies 仍有效，跳过扫码')
      return
    }
    // 2. cookies 失效 → 真扫码 (cron 触发场景下 user 必须在终端)
    await browserLoginByQR(session.page)
    console.log('✅ [AUTO.login] 扫码登录完成')
  } finally {
    // 3. finally 兜底 Chrome 泄漏 (per send-handler.ts:161-168 同模式)
    try {
      await closeBrowserSession(session)
    } catch (closeErr) {
      const msg = closeErr instanceof Error ? closeErr.message : String(closeErr)
      console.warn(`[AUTO.login] closeSession 失败（已忽略）: ${msg}`)
    }
  }
}

// ============================================================
// Sprint E-3.2: defaultBossSearch — search + LLM 评分 + 写飞书
// ============================================================

/**
 * 默认 bossSearch: 调 runSearchAndWrite 拿 passingJobs → 返 AutoJob[] (带 recordId).
 *
 * 复用 search-and-write.ts 的搜索+评分+写飞书完整流程 (已 GREEN 单测).
 * 不为 dryRun 提供 (buildDefaultDeps 在 dryRun=true 时返 STUB).
 */
async function defaultBossSearch(
  opts: BuildDefaultDepsOpts,
): Promise<(date: string) => Promise<AutoJob[]>> {
  // 1. 准备搜索循环 (config.searches[] 单 query, 跑第 1 个)
  const search = opts.config.searches[0]
  if (!search) {
    throw new Error('[AUTO.bossSearch] config.searches[] 空, 无法搜索')
  }
  const keyword = search.keyword
  const city = search.city
  const limit = search.limit ?? 15

  // 2. 准备 deps (test 注入优先, 默认走真实现)
  const noThreshold = opts.autoDeps?.noThreshold ?? false
  // 阈值优先级: opts.autoDeps.scoreThreshold > env SCORE_THRESHOLD > 0.85 (与 bapply search .env 默认一致)
  const scoreThreshold = opts.autoDeps?.scoreThreshold
    ?? (process.env.SCORE_THRESHOLD ? Number(process.env.SCORE_THRESHOLD) : 0.85)

  // appToken/tableId: opts.autoDeps 提供或自动从 loadConfig + env 读
  let appToken = opts.autoDeps?.appToken
  let tableId = opts.autoDeps?.tableId
  if (!appToken || !tableId) {
    try {
      const cfg = loadConfig()
      appToken = appToken ?? cfg.feishu.appToken ?? ''
      tableId = tableId ?? cfg.feishu.tableId ?? ''
    } catch {
      // loadConfig 失败 → dryRun 模式也可继续 (createRecord 走 noop)
    }
  }

  // LLM: test 注入优先, 默认 createLLM(loadConfig())
  let llm: unknown = opts.autoDeps?.llm
  if (!llm) {
    try {
      llm = createLLM(loadConfig())
    } catch {
      llm = undefined
    }
  }

  // createRecord: test 注入 → appToken/tableId 都有 → 真 feishu → noop
  const createRecordFn: (fields: any) => Promise<{ record_id: string }> =
    opts.autoDeps?.createRecord
    ?? (appToken && tableId
        ? (fields: any) => feishuCreateRecord(appToken!, tableId!, fields)
        : async (_fields: any) => ({ record_id: 'dry-run-noop' }))

  const cdp = opts.cdp ?? opts.autoDeps?.cdp ?? false

  return async (_date: string): Promise<AutoJob[]> => {
    const session = await (cdp ? createCDPSession() : createBrowserSession(false))
    let jobs: AutoJob[] = []
    try {
      // 构造 deps 调 runSearchAndWrite (与 cli/index.ts:283-295 同模式)
      const swDeps = {
        searchJobs: async (_k: string, _c?: string) => {
          return browserSearchJobs(session.page, keyword, city, undefined, { maxResults: limit })
        },
        fetchJobDetail: (jobId: string, ctx?: { lid?: string; securityId?: string }) =>
          browserFetchJobDetail(session.page, jobId, { lid: ctx?.lid, securityId: ctx?.securityId }),
        scoreJob: (jd: string, summary: any, _llm: unknown) => scoreJob(jd, summary, llm as any),
        createRecord: createRecordFn,
        resolveResume,
        llm,
        threshold: scoreThreshold,
      }
      const swOpts = {
        keyword,
        city,
        write: !opts.config.dryRun,
        dryRun: opts.config.dryRun,
        noThreshold,
        limit,
      }
      const result = await runSearchAndWrite(swOpts, swDeps)
      if (result.action === 'error') {
        throw new Error(`[AUTO.bossSearch] runSearchAndWrite error: ${result.error}`)
      }
      // passingJobs → AutoJob[]
      jobs = result.passingJobs.map((pj: PassingJob): AutoJob => ({
        id: pj.jobId,
        lid: pj.lid,
        securityId: pj.securityId,
        recordId: pj.recordId,
      }))
    } finally {
      try {
        await closeBrowserSession(session)
      } catch (closeErr) {
        const msg = closeErr instanceof Error ? closeErr.message : String(closeErr)
        console.warn(`[AUTO.bossSearch] closeSession 失败（已忽略）: ${msg}`)
      }
    }
    return jobs
  }
}

// ============================================================
// Sprint E-3.3: defaultSendGreeting — runSendCommand + writeGreetingStatus 写飞书
// ============================================================

/**
 * 默认 sendGreeting: 调 send-handler.runSendCommand (已 GREEN 含 5 状态 action).
 * 复用: runSendCommand 内部 close session + GuardError 透传.
 * 招呼语: 不调 LLM, 用 BOSS 默认招呼语 (per user 决策).
 */
async function defaultSendGreeting(
  opts: BuildDefaultDepsOpts,
): Promise<(job: AutoJob) => Promise<void>> {
  let appToken = opts.autoDeps?.appToken
  let tableId = opts.autoDeps?.tableId
  if (!appToken || !tableId) {
    try {
      const cfg = loadConfig()
      appToken = appToken ?? cfg.feishu.appToken ?? ''
      tableId = tableId ?? cfg.feishu.tableId ?? ''
    } catch { /* dryRun noop */ }
  }
  const cdp = opts.cdp ?? opts.autoDeps?.cdp ?? false
  const updateRecordFn = opts.autoDeps?.updateRecord
    ?? (appToken && tableId
        ? (recordId: string, fields: any) => feishuUpdateRecord(appToken!, tableId!, recordId, fields)
        : undefined)

  return async (job: AutoJob): Promise<void> => {
    const cmdOpts: SendCommandOptions = {
      jobId: job.id,
      lid: job.lid ?? '',
      securityId: job.securityId ?? '',
      recordId: job.recordId,
      cdp,
    }
    const cmdDeps: SendCommandDeps = {
      writeGreetingStatus: updateRecordFn
        ? async (recordId: string, status: string, greetedAt: number) => {
            return updateRecordFn(recordId, {
              打招呼状态: status,
              打招呼时间: greetedAt,
            })
          }
        : undefined,  // undefined = 跳飞书写入 (send-handler 已 graceful handle)
    }
    const result: SendCommandResult = await runSendCommand(cmdOpts, cmdDeps)
    // map result → throw (给 throttleSend 计入 stats.failed) 或 noop
    if (result.action === 'failed' || result.action === 'invalid_args') {
      throw new Error(`[AUTO.sendGreeting] ${result.action}: ${result.reason}`)
    }
    // ok/abort/abort_today: 不抛
  }
}

/**
 * E-1b: notifier 探测 (2 层 + fallback).
 * 4 字段显式透传 (per 架构师 review 必修正): webhookUrl / maxRetries / initialBackoffMs / timeoutMs.
 *
 * 类型收敛: `cfg` 在 truthy `cfg?.webhookUrl` 后窄化为 NonNullable,
 * 让 cfg.maxRetries 等字段访问无需再 ! / ?.
 */
function resolveNotifier(opts: BuildDefaultDepsOpts): AutoNotifier {
  // 1. opts.notifier 显式注入 (test/manual override, 优先级最高)
  if (opts.notifier) return opts.notifier

  // 2. config.notifier.webhookUrl 存在 → factory 4 字段全透传
  const cfg = opts.config.notifier
  const webhookUrl = cfg?.webhookUrl
  if (webhookUrl) {
    const factory = opts.notifierFactory ?? createFeishuNotifier
    return factory({
      webhookUrl,
      maxRetries: cfg.maxRetries,           // cfg 已窄化为 NotifierConfig
      initialBackoffMs: cfg.initialBackoffMs,
      timeoutMs: cfg.timeoutMs,
    })
  }

  // 3. fallback
  return consoleNotifier
}