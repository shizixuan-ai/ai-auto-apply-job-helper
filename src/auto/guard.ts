// ============================================================
// src/auto/guard.ts — Sprint C-2b §14.5 GREEN
// ------------------------------------------------------------
// 状态: GREEN (per §4.1, RED 已确认 import 失败)
// 覆盖: ADR §14.5 C-2b (R2 风控墙 / GuardError class + isGuardError)
// 纪律: §3.13 错误分层 (this.layer='GUARD' as const); throw 一律加 cause 链
// 单账号红线守住: 仅 class + helper, 不触碰 BOSS
// ============================================================

/** 风控触发原因 (per §14.2.3 关系图 reason 字段) */
export type GuardReason = 'anti_bot' | 'rate_limit' | 'ip_block'

/**
 * §14 R2 + ADR §9: BOSS 服务端风控触发 (环境异常 / 限流 / IP 封禁) 时抛出.
 * auto-handler 捕获后映射到 blocked 状态 + notifier critical + exit 2.
 *
 * @example
 *   throw new GuardError('环境异常', 'anti_bot', { cause: bossResp })
 */
export class GuardError extends Error {
  readonly layer = 'GUARD' as const  // per §3.13

  constructor(
    message: string,
    public reason: GuardReason,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'GuardError'
  }
}

/** Notifier 接口 (由 caller 实现; 此处仅类型) */
export interface GuardNotifier {
  notify(level: 'warn' | 'critical', msg: string): Promise<void>
}

/** Type guard: 安全识别 GuardError (避免 instanceof 漏判 cross-realm) */
export function isGuardError(e: unknown): e is GuardError {
  return e instanceof GuardError
}