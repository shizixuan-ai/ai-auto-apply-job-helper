// ============================================================
// CDP 接管：探测并连接用户本地 Chrome（RED STUB）
// ============================================================
// 设计要点（参见 docs/research/boss-auto-apply-2026-06-research.md §5.2）：
//   - 主路径：connectOverCDP 接管用户已登录的真 Chrome
//   - 端口探测：fetch /json/version（Playwright/Puppeteer 通用）
//   - 启动命令跨平台提示（mac/win/linux）
//   - 不可达抛 CDPUnavailableError，含明确恢复指引
//
// 后续 STEP（GREEN/REFACTOR）将实现：
//   - 真实 Playwright.connectOverCDP 集成
//   - browser/context 复用
//   - 健康检查 + 自动重连
// ============================================================

/** CDP 端点探测失败抛出的错误，含修复指引 */
export class CDPUnavailableError extends Error {
  readonly name = 'CDPUnavailableError'
  readonly endpoint: string

  constructor(message: string, endpoint: string) {
    super(message)
    this.endpoint = endpoint
  }
}

/** CDP wrapper：通过健康探测后的最小可用句柄 */
export interface CDPWrapper {
  readonly cdpURL: string
  readonly webSocketDebuggerUrl: string
  /** 重新探测一次端点，仍存活则返回 true */
  isAlive: () => Promise<boolean>
}

/** 默认 CDP 端口，可被 BOSS_CDP_PORT 环境变量覆盖 */
const DEFAULT_CDP_PORT = 9222

/** 单次 fetch 探测的超时上限（毫秒） */
const PROBE_TIMEOUT_MS = 2000

/** 解析 CDP 端口：环境变量 > 默认 9222 */
function resolvePort(): number {
  const raw = process.env.BOSS_CDP_PORT
  if (!raw) return DEFAULT_CDP_PORT
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0 || n > 65535) return DEFAULT_CDP_PORT
  return n
}

/** 推断 platform 与 chrome 可执行路径（用于提示） */
function detectChromePath(): string {
  if (process.platform === 'darwin') {
    return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  }
  if (process.platform === 'win32') {
    return 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  }
  return 'google-chrome'
}

/** 返回给用户打印的 Chrome 启动命令模板 */
export function getChromeLaunchInstructions(port: number = DEFAULT_CDP_PORT): string {
  const chrome = detectChromePath()
  const userDataDir = '~/.boss-chrome'
  return [
    '# 请在终端运行下面一行（或在 Chrome 中打开 chrome://inspect/#devices 后启动）:',
    `${chrome} --remote-debugging-port=${port} --user-data-dir=${userDataDir}`,
  ].join('\n')
}

/**
 * 探测 CDP 端口，确认用户的 Chrome 已启动并打开远程调试。
 * 不可达时抛 CDPUnavailableError，错误信息含完整启动命令。
 */
export async function connectToUserChrome(): Promise<CDPWrapper> {
  const port = resolvePort()
  const cdpURL = `http://127.0.0.1:${port}`

  let resp: Response
  try {
    resp = await fetch(`${cdpURL}/json/version`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
  } catch {
    throw new CDPUnavailableError(
      `CDP 端口 ${port} 不可达。请先启动 Chrome 的远程调试：\n${getChromeLaunchInstructions(port)}`,
      cdpURL,
    )
  }

  if (!resp.ok) {
    throw new CDPUnavailableError(
      `CDP 端口 ${port} 响应异常 (HTTP ${resp.status})。\n${getChromeLaunchInstructions(port)}`,
      cdpURL,
    )
  }

  const body = (await resp.json()) as {
    Browser?: string
    webSocketDebuggerUrl?: string
  }

  if (!body.webSocketDebuggerUrl) {
    throw new CDPUnavailableError(
      `CDP 端口 ${port} 返回数据缺少 webSocketDebuggerUrl。\n${getChromeLaunchInstructions(port)}`,
      cdpURL,
    )
  }

  return {
    cdpURL,
    webSocketDebuggerUrl: body.webSocketDebuggerUrl,
    isAlive: async () => {
      try {
        const r = await fetch(`${cdpURL}/json/version`, {
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        })
        return r.ok
      } catch {
        return false
      }
    },
  }
}

/**
 * 把 Playwright Browser 接管到已探测好的 CDP 端点。
 * 后续 browser/context/page 复用用户的真身份。
 *
 * 这是 §5.2 反爬转向的核心入口：
 *   - 不再启新 Chromium
 *   - 直接 connectOverCDP 到用户的真 Chrome
 *   - 复用其 cookies / Canvas 指纹 / TLS JA3 / 登录态
 */
export async function attachPlaywrightToCDP(wrapper: CDPWrapper) {
  const { chromium } = await import('playwright')
  return await chromium.connectOverCDP(wrapper.cdpURL)
}
