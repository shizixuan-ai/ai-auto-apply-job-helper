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
export const DEFAULT_CDP_PORT = 9222

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

/** 推断 platform 与 chrome 可执行路径（用于提示）。可被 BOSS_CHROME_PATH 覆盖。 */
export function detectChromePath(): string {
  const override = process.env.BOSS_CHROME_PATH
  if (override && override.trim().length > 0) {
    return override
  }
  if (process.platform === 'darwin') {
    return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  }
  if (process.platform === 'win32') {
    return 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  }
  return 'google-chrome'
}

/**
 * 检测路径是否含 shell 元字符（P0 安全债）
 *
 * 拒接包含以下字符的路径（即使来源是 .env）：
 *   ` $ & ; | < > ( ) { } [ ] \ 反引号 换行 \0
 *
 * 用户复制粘贴 `bapply chrome` 输出到终端时这些字符会被 shell 解释。
 * 例：BOSS_CHROME_PATH='/tmp/`rm -rf /`/chrome' 输出会触发任意命令执行。
 *
 * 合法路径字符范围：
 *   - 字母数字：`a-zA-Z0-9`
 *   - 路径分隔符：`/ \ :`
 *   - 路径常见字符：`- _ . , @ ~ = +`
 *   - 空格（macOS Beta.app 等真实场景需要）
 */
const SHELL_METACHAR_REGEX = /[`$&;|<>(){}\[\]\\\n\0]/
const SAFE_PATH_REGEX = /^[a-zA-Z0-9\s/\\:_.,@~=+\-]+$/

/** 抛出明确的元字符错误 */
export function assertPathSafe(p: string): void {
  const match = p.match(SHELL_METACHAR_REGEX)
  if (match) {
    throw new Error(
      `BOSS_CHROME_PATH contains shell metacharacter: ${JSON.stringify(match[0])}\n` +
        `Refusing to generate a launch command that could be exploited when copy-pasted.\n` +
        `Use a path containing only letters, digits, spaces, / \\ : _ . , @ ~ = + -`,
    )
  }
  if (!SAFE_PATH_REGEX.test(p)) {
    throw new Error(
      `BOSS_CHROME_PATH contains unsafe characters. Allowed: letters, digits, spaces, / \\ : _ . , @ ~ = + -`,
    )
  }
}

/**
 * 根据平台对路径加 shell quote（POSIX 用 '，Windows 用 "）
 * 已通过 assertPathSafe 校验过 → 这里只负责 quote，不再做 escape 内部字符。
 */
function shellQuote(p: string): string {
  if (process.platform === 'win32') {
    // PowerShell / cmd 接受双引号
    return p.includes(' ') ? `"${p}"` : p
  }
  // POSIX：含空格 → 单引号包裹（不含单引号，因为前一步已校验）
  return p.includes(' ') ? `'${p}'` : p
}

/** 返回给用户打印的 Chrome 启动命令模板（P0 安全：shellQuote 包裹路径） */
export function getChromeLaunchInstructions(port: number = DEFAULT_CDP_PORT): string {
  const chrome = detectChromePath()
  assertPathSafe(chrome) // 拒绝含 shell 元字符的路径（防御用户 .env 被污染）
  const quotedChrome = shellQuote(chrome)
  const userDataDir = '~/.boss-chrome'
  return [
    '# 请在终端运行下面一行（或在 Chrome 中打开 chrome://inspect/#devices 后启动）:',
    // 注意：'--remote-allow-origins=*' 必须单引号包裹，
    // zsh 默认会把 * 当 glob 通配符展开（macOS 主流 shell）
    `${quotedChrome} --remote-debugging-port=${port} --user-data-dir=${userDataDir} '--remote-allow-origins=*'`,
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
  // Sprint 临时修复：playwright 1.52+ 在 connectOverCDP 时自动调 Browser.setDownloadBehavior，
  // 新版 Chrome 拒绝 "Browser context management is not supported"。
  // noDefaults: true 关闭默认覆盖（acceptDownloads/focusEmulation/mediaEmulation），
  // 适合接管用户的真 Chrome。
  return await chromium.connectOverCDP(wrapper.cdpURL, { noDefaults: true })
}
