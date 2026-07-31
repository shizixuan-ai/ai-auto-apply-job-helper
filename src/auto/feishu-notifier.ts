// ============================================================
// src/auto/feishu-notifier.ts — Sprint E-1 §13 GREEN
// ------------------------------------------------------------
// 状态: GREEN (per §4.1, RED 已确认 module 找不到)
// 覆盖: ADR §17.9 E-1 (飞书 webhook notifier; replace console.log path)
//       + 架构师 review 必修正 (飞书 webhook 业务失败用 body code 不用 HTTP 2xx)
//       + 架构师 review 强烈建议 (msg 长度截断 19000 + 后缀)
// 纪律: §3.13 错误分层 (warnLogger msg 前缀 [FEISHU]); §3.9 不变量
//       (notify 永不 throw, 失败仅 warnLogger — 与 consoleNotifier 同契约);
//       §3.10 refactor: 新模块, 新 export, 0 caller 改动 (本 sprint 不改 buildDefaultDeps);
//       §3.12 probe: scripts/probe-feishu-notifier.mjs 7/7 PASS (A1-A7 全绿)
// 单账号红线守住: 0 触碰 BOSS (feishu webhook ≠ BOSS, mock 完全 inject)
// ============================================================

import type { AutoNotifier } from '../cli/handlers/auto-handler'

/** 飞书文本消息安全上限 (公开文档: 20KB; 留 buffer 给 tag prefix + 后缀) */
const FEISHU_MAX_MSG_LEN = 19000
/** 截断后缀 (per 架构师 review 防御性编程) */
const FEISHU_TRUNCATED_SUFFIX = '...(truncated)'

/**
 * createFeishuNotifier 配置 (per §13.7 关系图 + 架构师 review).
 * 所有非 webhookUrl 字段为可选, 工厂函数内部 fallback 默认值.
 */
export interface FeishuNotifierOpts {
  /** 飞书自定义机器人 webhook URL (必填) */
  webhookUrl: string
  /** 最大尝试次数 (默认 3 = 1 初次 + 2 重试) */
  maxRetries?: number
  /** 初始 backoff 毫秒 (默认 1000), 退避: initial × 2^attempt */
  initialBackoffMs?: number
  /** 单次请求超时毫秒 (默认 5000) */
  timeoutMs?: number
  /** fetch 实现注入 (测试用, 默认 globalThis.fetch) */
  fetch?: typeof fetch
  /** sleep 注入 (测试用, 默认 setTimeout-based Promise) */
  sleep?: (ms: number) => Promise<void>
  /** warn 注入 (测试用, 默认 console.warn with [FEISHU] 前缀) */
  warnLogger?: (msg: string) => void
}

/**
 * 格式化文本为飞书 markdown 文本 (warn/critical 区分 + 长度截断).
 *
 * @example
 *   formatFeishuText('critical', '风控触发')  // '🔴 [CRITICAL] 风控触发'
 */
export function formatFeishuText(
  level: 'warn' | 'critical',
  msg: string,
): string {
  const tag = level === 'critical' ? '🔴 [CRITICAL]' : '🟡 [WARN]'
  const text = msg.length > FEISHU_MAX_MSG_LEN
    ? msg.slice(0, FEISHU_MAX_MSG_LEN) + FEISHU_TRUNCATED_SUFFIX
    : msg
  return `${tag} ${text}`
}

/**
 * 创建飞书 notifier (per §13.7 关系图 + 架构师 review 必修正 + 强烈建议).
 *
 * **§3.13 错误分层**: 失败 → warnLogger(`[FEISHU] <msg>`), 不引入新 error class
 *   (失败属运维告警, 不属程序错误).
 * **§3.9 不变量**: `notify` 永不 throw, 与 `consoleNotifier` 同契约,
 *   让外层 `runDailyLoop` 不感知 webhook 失败.
 *
 * **架构师 review 必修正**: 飞书 webhook 总是 HTTP 200, 业务结果在 body `code` 字段.
 *   仅信 HTTP 2xx = 静默成功. 我们解析 JSON 并检查 `code === 0`.
 *
 * **架构师 review 强烈建议**: msg > 19000 → 截断 + '...(truncated)' 后缀
 *   (飞书 20KB 限制, 防止超长日志导致发送失败).
 *
 * @example
 *   const notifier = createFeishuNotifier({
 *     webhookUrl: process.env.FEISHU_WEBHOOK_URL!,
 *   })
 *   await notifier.notify('critical', '[AUTO.guard] anti_bot 触发')
 */
export function createFeishuNotifier(opts: FeishuNotifierOpts): AutoNotifier {
  if (!opts.webhookUrl) {
    throw new Error('[FEISHU] webhookUrl is required')
  }
  const {
    webhookUrl,
    maxRetries = 3,
    initialBackoffMs = 1000,
    timeoutMs = 5000,
    fetch: fetchImpl = globalThis.fetch.bind(globalThis),
    sleep: sleepImpl = defaultSleep,
    warnLogger = defaultWarnLogger,
  } = opts

  async function notify(level: 'warn' | 'critical', msg: string): Promise<void> {
    const body = JSON.stringify({
      msg_type: 'text',
      content: { text: formatFeishuText(level, msg) },
    })

    let lastError: unknown
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const ctrl = new AbortController()
      const tid = setTimeout(() => ctrl.abort(), timeoutMs)
      try {
        const resp = await fetchImpl(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          signal: ctrl.signal,
        })
        clearTimeout(tid)

        if (resp.ok) {
          // [架构师 review 必修正] 飞书 webhook 总是 HTTP 200, 业务结果在 body code
          // 仅信 HTTP 2xx = 静默成功 (URL 失效或消息错时), 必须解析 body
          const json = await resp.json() as { code?: number; msg?: string }
          if (json.code === 0) {
            return  // 业务成功
          }
          // 业务失败 — 不重试 (URL 失效/格式错, 重试无效)
          lastError = new Error(
            `feishu business error: code=${json.code} msg=${json.msg}`,
          )
          break
        }

        // 4xx 不重试 (per 架构师 review: 客户端错误不应重发)
        if (resp.status >= 400 && resp.status < 500) {
          lastError = new Error(`HTTP ${resp.status} (no retry)`)
          break
        }

        // 5xx: 继续重试
        lastError = new Error(`HTTP ${resp.status}`)
      } catch (e) {
        clearTimeout(tid)
        lastError = e  // 网络/timeout/json parse 错都重试
      }
      // 退避: initial × 2^attempt (最后 attempt 不 sleep)
      if (attempt < maxRetries - 1) {
        await sleepImpl(initialBackoffMs * 2 ** attempt)
      }
    }

    // §3.9 不变量: 不抛, 仅 warnLogger
    warnLogger(
      `${maxRetries}/${maxRetries} attempts failed: ${errorMessage(lastError)}`,
    )
  }

  return { notify }
}

// ─── helpers ────────────────────────────────────────────────────

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function defaultWarnLogger(msg: string): void {
  console.warn(`[FEISHU] ${msg}`)
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}
