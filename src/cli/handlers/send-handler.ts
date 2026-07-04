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
} from '../../browser/index.js'

// ============================================================
// 类型
// ============================================================

export interface SendCommandOptions {
  /** 岗位 ID（encryptJobId） */
  jobId: string
  /** 话术内容（-m / --message） */
  message?: string
  /** 是否通过 CDP 连接已有 Chrome */
  cdp?: boolean
}

/**
 * 注入式依赖：测试可替换，生产用真实实现
 * 全部 optional，handler 在缺省时回退到 src/browser/index.js 的真实实现
 */
export interface SendCommandDeps {
  sendGreeting?: (
    page: any,
    jobId: string,
    message: string,
  ) => Promise<boolean>
  createSession?: (cdp: boolean) => Promise<any>
  closeSession?: (session: any) => Promise<void>
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
  if (!opts.message) {
    return {
      action: 'invalid_args',
      reason: '请通过 -m 指定话术内容',
    }
  }

  // 2. 注入式依赖（默认走真实实现）
  const sendGreetingFn = deps.sendGreeting ?? sendGreeting
  const createSessionFn = deps.createSession ?? defaultCreateSession
  const closeSessionFn = deps.closeSession ?? closeBrowserSession

  // 3. 创建 session + 执行 + 清理（finally 兜底防 Chrome 泄漏）
  const session = await createSessionFn(opts.cdp ?? false)
  try {
    const ok = await sendGreetingFn(session.page, opts.jobId, opts.message)
    if (ok) {
      return { action: 'ok', reason: '发送成功' }
    }
    return {
      action: 'failed',
      reason: '发送失败（详见 BOSS 页面或浏览器日志）',
    }
  } catch (err) {
    // P0 fix: GuardError 必须捕获 → 透传为同 action 的 result
    if (err instanceof GuardError) {
      const a = err.decision.action
      if (a === 'abort_today' || a === 'abort') {
        return {
          action: a,
          reason: err.decision.reason,
        }
      }
    }
    // 非 GuardError：业务错误（如 navigation timeout / page closed）
    const msg = err instanceof Error ? err.message : String(err)
    return {
      action: 'failed',
      reason: `发送失败：${msg}`,
    }
  } finally {
    await closeSessionFn(session)
  }
}

// ============================================================
// 内部 helpers
// ============================================================

async function defaultCreateSession(cdp: boolean) {
  return cdp ? createCDPSession() : createBrowserSession(false)
}