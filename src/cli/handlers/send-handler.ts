// ============================================================
// `bapply send` 子命令 handler — GREEN 实现
// ============================================================
// 职责：把 send action 的副作用（创建 session / 调 sendGreeting / 清理）
// 抽成纯函数 + Result 类型，让 CLI 层只负责 exit code 映射。
//
// 为什么抽出来：
//   1. P0 audit: CLI send 在 GuardError 抛出时是 unhandled rejection
//      → Node 打印 stack trace → 用户体验差 + exit code 错乱
//   2. 抽函数后能用 vitest 注入 mock sendGreeting，覆盖所有分支
//   3. CLI 层只剩 4 行 dispatch 代码（switch action → exit code）
//
// 契约（test contract）：
//   - 缺 message → invalid_args（早返回，不创建 session）
//   - GuardError(abort_today|abort) → 同名 action + decision.reason
//   - sendGreeting 返 false → failed
//   - sendGreeting 抛非 GuardError → failed + 原 message
//   - sendGreeting 返 true → ok
//   - 所有路径 closeSession 必须 finally 调用（防 Chrome 泄漏）
// ============================================================

import { GuardError } from '../../browser/guard.js'
import {
  createBrowserSession,
  createCDPSession,
  closeBrowserSession,
  sendGreeting,
  type SendGreetingResult,
} from '../../browser/index.js'
import type { GreetStatus } from '../../types/index.js'

/** GreetStatus → 飞书"打招呼状态"单选中文 label 映射（与 add-sprint-2a-fields.mjs options 严格对齐） */
const STATUS_LABEL: Record<GreetStatus, string> = {
  pending: '待发送',
  sent: '已发送',
  failed: '失败',
  rate_limited: '触发限额',
  security_blocked: '风控拦截',
  /** Sprint 2026-07-14 新增：探针 P1/P2/P3 实测 bossCode=1011 */
  session_expired: '登录已失效',
}

// ============================================================
// 类型
// ============================================================

export interface SendCommandOptions {
  /** 岗位 ID（encryptJobId） */
  jobId: string
  /**
   * BOSS list-context lid（Sprint 2026-07-14 / ADR-0007 P3 协议必传）
   * 来源：search/joblist.json 响应 jobList[].lid
   */
  lid: string
  /**
   * BOSS 风控 token（同上必传）
   * 来源：search/joblist.json 响应 jobList[].securityId
   */
  securityId: string
  /** 飞书记录 ID（如果有，写回打招呼状态） */
  recordId?: string
  /** 是否通过 CDP 连接已有 Chrome */
  cdp?: boolean
}

/**
 * 注入式依赖：测试可替换，生产用真实实现
 * 全部 optional，handler 在缺省时回退到 src/browser/index.js 的真实实现
 */
export interface SendCommandDeps {
  /**
   * sendGreeting 签名（Sprint 2026-07-14 / task #41 / ADR-0007 P3 协议）：
   *   (page, jobId, lid, securityId) — 不再传 hrUid / message
   */
  sendGreeting?: (
    page: any,
    jobId: string,
    lid: string,
    securityId: string,
  ) => Promise<SendGreetingResult>
  createSession?: (cdp: boolean) => Promise<any>
  closeSession?: (session: any) => Promise<void>
  /**
   * 写飞书记录（Sprint 2A.2）
   *   - recordId: 飞书记录 ID
   *   - status: 5 状态 GreetStatus
   *   - greetedAt: 毫秒时间戳
   *   - 由 CLI 层包装 updateRecord(config.feishu.appToken, tableId, ...)
   *   - 失败不阻塞 send 主流程（仅 console.error + 写到 result.reason）
   */
  writeGreetingStatus?: (
    recordId: string,
    status: GreetStatus,
    greetedAt: number,
  ) => Promise<unknown>
}

export type SendCommandAction =
  | 'ok' // exit 0
  | 'failed' // exit 1
  | 'invalid_args' // exit 2
  | 'abort_today' // exit 3 ← 风控今日上限
  | 'abort' // exit 4 ← 风控不可恢复

export interface SendCommandResult {
  action: SendCommandAction
  reason: string
}

// ============================================================
// 纯函数
// ============================================================

export async function runSendCommand(
  opts: SendCommandOptions,
  deps: SendCommandDeps = {},
): Promise<SendCommandResult> {
  // 1. 参数校验（早返回，避免创建不必要的 session）
  // Sprint 2026-07-14 / ADR-0007：移除 message / hrUid 校验 → 改为 lid / securityId
  if (!opts.lid) {
    return {
      action: 'invalid_args',
      reason: '请通过 -l 指定 BOSS list-context lid（来自 search 输出）',
    }
  }
  if (!opts.securityId) {
    return {
      action: 'invalid_args',
      reason: '请通过 -s 指定 BOSS 风控 token securityId（来自 search 输出）',
    }
  }

  // 2. 注入式依赖（默认走真实实现）
  const sendGreetingFn = deps.sendGreeting ?? sendGreeting
  const createSessionFn = deps.createSession ?? defaultCreateSession
  const closeSessionFn = deps.closeSession ?? closeBrowserSession

  // 3. 创建 session + 执行 + 清理（finally 兜底防 Chrome 泄漏）
  const session = await createSessionFn(opts.cdp ?? false)
  let sendResult: SendGreetingResult | null = null
  try {
    // Sprint 2026-07-14 / ADR-0007：4 参数签名 (page, jobId, lid, securityId)
    sendResult = await sendGreetingFn(session.page, opts.jobId, opts.lid, opts.securityId)
  } catch (err) {
    // P0 fix: GuardError 必须捕获 → 透传为同 action 的 result
    if (err instanceof GuardError) {
      const a = err.decision.action
      if (a === 'abort_today' || a === 'abort') {
        // 风控触发时：未真正发起打招呼，不写飞书
        return {
          action: a,
          reason: err.decision.reason,
        }
      }
    }
    // 非 GuardError：业务错误（如 navigation timeout / page closed）
    // → 标记为 failed，让飞书记录显示"失败"（如果 recordId 提供）
    const msg = err instanceof Error ? err.message : String(err)
    sendResult = { action: 'failed', error: msg }
  } finally {
    // closeSession 抛错不能掩盖原始 error（业务/GuardError）
    try {
      await closeSessionFn(session)
    } catch (closeErr) {
      const msg = closeErr instanceof Error ? closeErr.message : String(closeErr)
      console.warn(`[send-handler] closeSession 失败（已忽略）: ${msg}`)
    }
  }

  // 4. Sprint 2A.2: 写飞书（如有 recordId）
  //   - 写失败不阻塞 send 主流程（仅 console.error + 在 reason 标注）
  let writebackNote = ''
  if (sendResult && opts.recordId && deps.writeGreetingStatus) {
    try {
      await deps.writeGreetingStatus(opts.recordId, sendResult.action, Date.now())
      writebackNote = '（飞书已更新）'
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error(`[send-handler] 写飞书失败（已忽略）: ${msg}`)
      writebackNote = `（飞书写入失败: ${msg}）`
    }
  }

  // 5. 5 状态 → 4 SendCommandAction 映射
  if (sendResult.action === 'sent') {
    return {
      action: 'ok',
      reason: `发送成功（friendId=${sendResult.friendId ?? 'n/a'}）${writebackNote}`,
    }
  }
  return {
    action: 'failed',
    reason: `发送失败（${sendResult.action}）：${sendResult.error ?? '未知'}${writebackNote}`,
  }
}

// ============================================================
// 内部 helpers
// ============================================================

async function defaultCreateSession(cdp: boolean) {
  return cdp ? createCDPSession() : createBrowserSession(false)
}