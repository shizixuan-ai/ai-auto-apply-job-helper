// ============================================================
// src/auto/session-detector.ts — §12 Issue 3 BOSS 响应探测
// ------------------------------------------------------------
// 状态: Sprint B-2 Phase C (per ADR §9 后续)
// 职责: 从 BOSS wapi 响应中探测 session 过期 (401 / 未登录),
//       抛 SessionExpiredError 给 throttleSend 触发重登链路
// 纪律: §3.13 错误分层 (检测到 session 过期 → SessionExpiredError layer='SEND');
//       §3.12 关系: 探针语义, 真实 BOSS 响应格式待 probe (单账号红线)
// ============================================================

import { SessionExpiredError } from './throttle'

/**
 * BOSS 响应统一形态 (从 wapi / browser 抓到的 JSON 或 HTTP 响应).
 * 字段保留灵活以适配真实响应变化 (待 Sprint B Phase B probe).
 */
export interface BossResponse {
  status?: number         // HTTP status code
  body?: unknown          // 响应 body (parsed JSON)
  message?: string        // 错误消息 (可选)
  text?: string           // 原始文本 (CDP 抓包)
}

/**
 * 探测 BOSS 响应是否 session 过期.
 * @returns SessionExpiredError 当 session 过期; null 当正常
 *
 * 触发条件 (per ADR §12 Issue 3):
 *   - HTTP 401
 *   - body.code === 401
 *   - body.message / message 包含 "未登录" / "session" / "token"
 */
export function detectSessionExpired(response: BossResponse): SessionExpiredError | null {
  // 1. HTTP 401
  if (response.status === 401) {
    return new SessionExpiredError('401 from BOSS')
  }

  // 2. body.code === 401
  const body = response.body
  if (typeof body === 'object' && body !== null) {
    const obj = body as Record<string, unknown>
    if (obj.code === 401) {
      return new SessionExpiredError('BOSS 响应 code=401')
    }
    // 3. message 包含 "未登录" 等关键字
    const msg = obj.message ?? obj.msg
    if (typeof msg === 'string') {
      if (/未登录|session.*expired|token.*invalid/i.test(msg)) {
        return new SessionExpiredError(`BOSS 未登录: ${msg}`)
      }
    }
  }

  // 4. 顶层 message 字段
  if (typeof response.message === 'string'
    && /未登录|session.*expired|token.*invalid/i.test(response.message)) {
    return new SessionExpiredError(`BOSS 未登录: ${response.message}`)
  }

  return null
}
