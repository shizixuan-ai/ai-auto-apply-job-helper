// ============================================================
// 风控降级中间件 — GREEN 实现（完整 + withGuard 语义修正）
// ============================================================
// 设计参见 §5.2.5 流程图 + review 后整合的 4 类图。
//
// withGuard 语义（最终）：
//   1. 同步探针（fn 执行前跑一次 page.$）
//      - 命中 abort_* → notify + throw GuardError（fn 不被调用）
//      - 命中 pause  → notify + race(waitForSelector(hidden), sleep(maxPauseMs))
//        - 弹窗消失 + waitForUserConfirm → 进入第 2 步
//        - 超时 → notify(ABORT_TODAY) + throw GuardError（fn 不被调用）
//      - 无信号 → 进入第 2 步
//   2. 启动 interval 探针 + 执行 fn
//      - fn 完成 → 清探针 → 检查 fn 期间是否命中
//        - pause → race + confirm → 返回 fn 结果
//        - abort → throw GuardError
//        - 无 → 返回 fn 结果
// ============================================================

import { spawn } from 'node:child_process'

// ============================================================
// 类型
// ============================================================

export type SignalType =
  | 'verify_captcha'
  | 'verify_slider'
  | 'rate_limit'
  | 'login_expired'
  | 'safe'

export type GuardAction = 'continue' | 'pause' | 'abort_today' | 'abort'

export interface RiskSignal {
  type: SignalType
  confidence: number
  rawSelector: string
  detectedAt: Date
}

export interface GuardDecision {
  action: GuardAction
  reason: string
  signal: RiskSignal
  expiresAt?: Date
}

export interface GuardConfig {
  probeIntervalMs: number
  maxPauseMs: number
  maxRetries: number
  captchaSelectors: string[]
  sliderSelectors: string[]
  rateLimitSelectors: string[]
  loginExpiredSelectors: string[]
  fallbackDialogSelector: string
}

export const DEFAULT_GUARD_CONFIG: GuardConfig = {
  probeIntervalMs: 5000,
  maxPauseMs: 600_000,
  maxRetries: 3,
  captchaSelectors: [],
  sliderSelectors: [],
  rateLimitSelectors: [],
  loginExpiredSelectors: [],
  fallbackDialogSelector: '[role="dialog"]',
}

// ============================================================
// 错误
// ============================================================

export class GuardError extends Error {
  readonly decision: GuardDecision
  readonly name = 'GuardError'

  constructor(decision: GuardDecision) {
    super(decision.reason)
    this.decision = decision
  }
}

// ============================================================
// Notifier 接口与实现
// ============================================================

export interface Notifier {
  notify(decision: GuardDecision): Promise<void>
}

export class OSNotifier implements Notifier {
  private readonly platform: NodeJS.Platform

  constructor(platform?: NodeJS.Platform) {
    this.platform = platform ?? process.platform
  }

  async notify(decision: GuardDecision): Promise<void> {
    const title = 'bapply 风控提示'
    const body = decision.reason
    const fallbackLog = () =>
      console.log(`\n🔔 [${title}]\n   ${body}\n`)

    let cmd: string
    let args: string[]

    if (this.platform === 'darwin') {
      cmd = 'osascript'
      args = ['-e', `display notification "${body}" with title "${title}"`]
    } else if (this.platform === 'linux') {
      cmd = 'notify-send'
      args = [body]
    } else {
      fallbackLog()
      return
    }

    await new Promise<void>((resolve) => {
      const child = spawn(cmd, args)
      child.on('exit', (code) => {
        if (code !== 0) fallbackLog()
        resolve()
      })
      child.on('error', () => {
        fallbackLog()
        resolve()
      })
    })
  }
}

export class ConsoleNotifier implements Notifier {
  async notify(decision: GuardDecision): Promise<void> {
    const tag = decision.action.toUpperCase().padEnd(12)
    console.log(`\n🔔 [${tag}] ${decision.reason}\n`)
  }
}

// ============================================================
// 纯函数
// ============================================================

export function evaluateSignal(
  signal: RiskSignal,
  config: GuardConfig,
): GuardDecision {
  switch (signal.type) {
    case 'verify_captcha':
      return {
        action: 'pause',
        reason: `检测到验证码弹窗（${signal.rawSelector}）。请在真实 Chrome 中手动完成后按回车继续。`,
        signal,
        expiresAt: new Date(Date.now() + config.maxPauseMs),
      }
    case 'verify_slider':
      return {
        action: 'pause',
        reason: `检测到滑块验证（${signal.rawSelector}）。请在真实 Chrome 中手动完成。`,
        signal,
        expiresAt: new Date(Date.now() + config.maxPauseMs),
      }
    case 'rate_limit':
      return {
        action: 'abort_today',
        reason: `今日已达上限（${signal.rawSelector}）。今日任务停止，明日自动恢复。`,
        signal,
      }
    case 'login_expired':
      return {
        action: 'abort_today',
        reason: `登录已失效（${signal.rawSelector}）。请重新登录后再运行 bapply。`,
        signal,
      }
    case 'safe':
    default:
      return {
        action: 'continue',
        reason: 'safe',
        signal,
      }
  }
}

const PRIORITY: Record<SignalType, number> = {
  verify_captcha: 5,
  verify_slider: 5,
  rate_limit: 4,
  login_expired: 4,
  safe: 0,
}

export function aggregateSignals(signals: RiskSignal[]): RiskSignal | null {
  if (signals.length === 0) return null
  return signals.reduce((top, s) =>
    PRIORITY[s.type] > PRIORITY[top.type] ? s : top,
  )
}

// ============================================================
// 探针（依赖 Playwright Page）
// ============================================================

async function probeGroup(
  page: { $: (sel: string) => Promise<unknown> },
  selectors: string[],
  type: SignalType,
): Promise<RiskSignal[]> {
  const out: RiskSignal[] = []
  for (const sel of selectors) {
    const el = await page.$(sel)
    if (el) {
      out.push({
        type,
        confidence: 1,
        rawSelector: sel,
        detectedAt: new Date(),
      })
    }
  }
  return out
}

export async function probeRiskSignals(
  page: { $: (sel: string) => Promise<unknown> },
  config: GuardConfig,
): Promise<RiskSignal[]> {
  const groups = [
    probeGroup(page, config.captchaSelectors, 'verify_captcha'),
    probeGroup(page, config.sliderSelectors, 'verify_slider'),
    probeGroup(page, config.rateLimitSelectors, 'rate_limit'),
    probeGroup(page, config.loginExpiredSelectors, 'login_expired'),
  ]
  const settled = await Promise.all(groups)
  const hardHits = settled.flat()

  if (hardHits.length === 0 && config.fallbackDialogSelector) {
    const fb = await page.$(config.fallbackDialogSelector)
    if (fb) {
      return [
        {
          type: 'safe',
          confidence: 0.3,
          rawSelector: config.fallbackDialogSelector,
          detectedAt: new Date(),
        },
      ]
    }
  }

  return hardHits
}

// ============================================================
// 高阶函数 withGuard（核心 API）
// ============================================================

export interface WithGuardOptions {
  config?: GuardConfig
  notifier?: Notifier
  /** CLI 层注入：用户在真实浏览器手动完成后按回车 */
  waitForUserConfirm?: () => Promise<void>
}

export interface GuardedPage {
  $: (sel: string) => Promise<unknown>
  waitForSelector: (sel: string, opts?: unknown) => Promise<unknown>
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms))

class PauseTimeoutError extends Error {
  readonly name = 'PauseTimeoutError'
  constructor() {
    super('pause timeout')
  }
}

/**
 * 处理单个 signal（pause race / abort）
 * - pause: race(waitForSelector(hidden), sleep(maxPauseMs))
 *   - 超时 → throw GuardError(ABORT_TODAY)
 *   - 弹窗消失 → waitForUserConfirm → resolve
 * - abort_*: throw GuardError
 */
async function handleSignal(
  page: GuardedPage,
  signal: RiskSignal,
  config: GuardConfig,
  notifier: Notifier,
  waitForUserConfirm?: () => Promise<void>,
): Promise<'resume' | never> {
  const decision = evaluateSignal(signal, config)
  await notifier.notify(decision)

  if (decision.action === 'abort_today' || decision.action === 'abort') {
    throw new GuardError(decision)
  }

  if (decision.action === 'pause') {
    try {
      await Promise.race([
        page.waitForSelector(signal.rawSelector, { state: 'hidden' }),
        sleep(config.maxPauseMs).then(() => Promise.reject(new PauseTimeoutError())),
      ])
    } catch (err) {
      if (err instanceof PauseTimeoutError) {
        const timeoutDecision: GuardDecision = {
          action: 'abort_today',
          reason: `等待验证超时（${config.maxPauseMs}ms），今日任务停止。`,
          signal,
        }
        await notifier.notify(timeoutDecision)
        throw new GuardError(timeoutDecision)
      }
      throw err
    }

    if (waitForUserConfirm) await waitForUserConfirm()
    return 'resume'
  }

  // continue: 不阻塞
  return 'resume'
}

/**
 * withGuard：包装任意业务函数在风控监控下
 */
export async function withGuard<T>(
  page: GuardedPage,
  fn: () => Promise<T>,
  options: WithGuardOptions = {},
): Promise<T> {
  const config = options.config ?? DEFAULT_GUARD_CONFIG
  const notifier = options.notifier ?? new ConsoleNotifier()
  const waitForUserConfirm = options.waitForUserConfirm

  // Step 1: 同步探针（fn 执行前）
  const initialSigs = await probeRiskSignals(page, config)
  const initialTop = aggregateSignals(initialSigs)
  if (initialTop) {
    await handleSignal(page, initialTop, config, notifier, waitForUserConfirm)
    // handleSignal resolve 后继续执行 fn
  }

  // Step 2: 启动 interval 探针 + 执行 fn
  let detectedDuringFn: RiskSignal | null = null
  const probeHandle = setInterval(async () => {
    try {
      const sigs = await probeRiskSignals(page, config)
      const top = aggregateSignals(sigs)
      if (top) detectedDuringFn = top
    } catch {
      /* 探针错误不阻塞 */
    }
  }, config.probeIntervalMs)

  let fnResult: T
  try {
    fnResult = await fn()
  } catch (err) {
    clearInterval(probeHandle)
    throw err
  }
  clearInterval(probeHandle)

  // Step 3: 检查 fn 期间是否检测到 signal
  if (detectedDuringFn) {
    await handleSignal(
      page,
      detectedDuringFn,
      config,
      notifier,
      waitForUserConfirm,
    )
  }

  return fnResult
}