// ============================================================
// `bapply chrome` 子命令 handler
// ============================================================
// 职责：打印用户本地 Chrome 的远程调试启动命令（含端口 + user-data-dir）
// 跨平台分支：macOS / Windows / Linux
//
// 这是一个纯函数，方便 vitest 在 RED→GREEN 阶段验证输出。
// ============================================================

import { getChromeLaunchInstructions } from '../../browser/cdp.js'

export interface ChromeHandlerOptions {
  /** 自定义端口，覆盖默认 9222 与 BOSS_CDP_PORT */
  port?: number
}

/**
 * 返回 `bapply chrome` 要打印到 stdout 的全部内容（含换行）。
 * 失败时返回 null（CLI 应以非零退出）。
 *
 * 当前契约（test contract）：
 *   - 必须包含 "--remote-debugging-port="
 *   - 必须包含 "--user-data-dir="
 *   - 必须包含 Chrome 可执行文件名
 *   - ports 反映传入的 port，未传则用默认 9222
 */
export function handleChromeCommand(options: ChromeHandlerOptions = {}): string {
  return getChromeLaunchInstructions(options.port ?? DEFAULT_PORT)
}

const DEFAULT_PORT = 9222
