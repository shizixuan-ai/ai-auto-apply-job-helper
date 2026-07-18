// ============================================================
// CDP 接管：单元测试（RED）
// ============================================================
// 目标：connectToUserChrome() 探测 9222 端口上的用户 Chrome：
//   - 不可达 → 抛 CDPUnavailableError（含启动命令提示）
//   - 可达   → 返回 wrapper（含 cdpURL / 连接 / 健康检查）
//   - 端口可通过 BOSS_CDP_PORT 覆盖
// ============================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  connectToUserChrome,
  attachPlaywrightToCDP,
  CDPUnavailableError,
  getChromeLaunchInstructions,
  detectChromePath,
} from './cdp.js'

// Mock Playwright's chromium BEFORE importing modules that use it
vi.mock('playwright', () => ({
  chromium: {
    connectOverCDP: vi.fn(),
  },
}))

describe('CDPUnavailableError', () => {
  it('is a subclass of Error', () => {
    const err = new CDPUnavailableError('test', 'http://x:9222')
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(CDPUnavailableError)
    expect(err.name).toBe('CDPUnavailableError')
  })

  it('carries the failing endpoint URL', () => {
    const err = new CDPUnavailableError('boom', 'http://127.0.0.1:9333')
    expect(err.endpoint).toBe('http://127.0.0.1:9333')
  })
})

describe('getChromeLaunchInstructions', () => {
  it('mentions --remote-debugging-port flag', () => {
    expect(getChromeLaunchInstructions()).toContain('--remote-debugging-port')
  })

  it('mentions --user-data-dir flag', () => {
    expect(getChromeLaunchInstructions()).toContain('--user-data-dir')
  })

  it('mentions Chrome binary name', () => {
    expect(getChromeLaunchInstructions()).toContain('Chrome')
  })

  // ============================================================
  // Chrome 111+ 安全策略：必须显式允许 zhipin.com origin
  // P0 实测发现：缺少 --remote-allow-origins=* 时 Chrome DevTools
  // 会拒绝来自 https://www.zhipin.com 的 WebSocket 连接，
  // 导致 Playwright connectOverCDP 接管时报 "about:blank"。
  // ============================================================

  it('emits --remote-allow-origins=* to permit zhipin.com origin (Chrome 111+)', () => {
    const out = getChromeLaunchInstructions()
    expect(out).toContain('--remote-allow-origins=*')
  })

  // ============================================================
  // zsh glob 修正：含 * 的 flag 必须用单引号包裹
  // P0 实测：用户复制 `--remote-allow-origins=*` 粘贴到 zsh
  // 会触发 "no matches found" 错误（* 被当成 glob 通配符）
  // 整个 flag 必须 'flag=value' quote 起来。
  // ============================================================

  it('quotes the *-suffixed flag with single quotes to avoid zsh glob expansion', () => {
    const out = getChromeLaunchInstructions()
    expect(out).toContain("'--remote-allow-origins=*'")
  })
})

// ============================================================
// detectChromePath：BOSS_CHROME_PATH 环境变量覆盖 (P2 #15)
// ============================================================

describe('detectChromePath', () => {
  let originalEnv: NodeJS.ProcessEnv

  beforeEach(() => {
    originalEnv = { ...process.env }
    delete process.env.BOSS_CHROME_PATH
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('returns the BOSS_CHROME_PATH value when env var is set (overrides platform default)', () => {
    process.env.BOSS_CHROME_PATH = '/custom/path/to/chrome'
    expect(detectChromePath()).toBe('/custom/path/to/chrome')
  })

  it('ignores empty-string BOSS_CHROME_PATH (falls back to platform default)', () => {
    process.env.BOSS_CHROME_PATH = ''
    expect(detectChromePath()).not.toBe('')
    expect(detectChromePath()).toContain('Chrome')
  })

  it('falls back to platform default when BOSS_CHROME_PATH is unset', () => {
    // 当前平台（darwin）下默认应包含 "Google Chrome"
    expect(detectChromePath()).toContain('Chrome')
  })

  it('getChromeLaunchInstructions uses BOSS_CHROME_PATH when set', () => {
    process.env.BOSS_CHROME_PATH = '/opt/custom/chrome'
    const out = getChromeLaunchInstructions()
    expect(out).toContain('/opt/custom/chrome')
    expect(out).not.toContain('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
  })

  // ============================================================
  // P0 安全债：路径必须 shell-escape 后才拼到输出（audit 衍生）
  // ============================================================

  it('P0: escape BOSS_CHROME_PATH containing spaces when generating launch command', () => {
    process.env.BOSS_CHROME_PATH = '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta'
    const out = getChromeLaunchInstructions()
    // 必须用单引号包裹（含空格的合法路径），避免用户复制到终端被拆词
    expect(out).toContain("'/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta'")
  })

  it('P0: refuse BOSS_CHROME_PATH containing shell metacharacters (defense-in-depth)', () => {
    process.env.BOSS_CHROME_PATH = '/path/with/`rm -rf $TMP && echo bad`/chrome'
    expect(() => getChromeLaunchInstructions()).toThrow(/shell metacharacter/i)
  })

  it('P0: refuse BOSS_CHROME_PATH containing backticks even when alone', () => {
    process.env.BOSS_CHROME_PATH = '/path/`whoami`/chrome'
    expect(() => getChromeLaunchInstructions()).toThrow(/shell metacharacter/i)
  })

  it('P0: refuse BOSS_CHROME_PATH containing $ expansion', () => {
    process.env.BOSS_CHROME_PATH = '/path/$HOME/chrome'
    expect(() => getChromeLaunchInstructions()).toThrow(/shell metacharacter/i)
  })
})

describe('connectToUserChrome', () => {
  let originalFetch: typeof globalThis.fetch
  let originalEnv: NodeJS.ProcessEnv

  beforeEach(() => {
    originalFetch = globalThis.fetch
    originalEnv = { ...process.env }
    delete process.env.BOSS_CDP_PORT
    globalThis.fetch = vi.fn() as any
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    process.env = originalEnv
    vi.restoreAllMocks()
  })

  it('throws CDPUnavailableError when fetch rejects (connection refused)', async () => {
    vi.mocked(globalThis.fetch).mockRejectedValue(new Error('ECONNREFUSED'))

    await expect(connectToUserChrome()).rejects.toBeInstanceOf(CDPUnavailableError)
  })

  it('error message contains Chrome launch instructions', async () => {
    vi.mocked(globalThis.fetch).mockRejectedValue(new Error('ECONNREFUSED'))

    await expect(connectToUserChrome()).rejects.toThrow(/remote-debugging-port/)
    await expect(connectToUserChrome()).rejects.toThrow(/Chrome/)
  })

  it('reads port from BOSS_CDP_PORT env var', async () => {
    process.env.BOSS_CDP_PORT = '9333'
    vi.mocked(globalThis.fetch).mockRejectedValue(new Error('refused'))

    try {
      await connectToUserChrome()
    } catch (err) {
      expect((err as CDPUnavailableError).endpoint).toContain('9333')
    }
  })

  it('defaults to port 9222 when no env var is set', async () => {
    vi.mocked(globalThis.fetch).mockRejectedValue(new Error('refused'))

    try {
      await connectToUserChrome()
    } catch (err) {
      expect((err as CDPUnavailableError).endpoint).toContain('9222')
    }
  })

  it('throws CDPUnavailableError when fetch returns non-ok status', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response('not found', { status: 404 }),
    )

    await expect(connectToUserChrome()).rejects.toBeInstanceOf(CDPUnavailableError)
  })

  it('succeeds and returns a wrapper when CDP endpoint responds with version info', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          Browser: 'Chrome/120.0.6099.130',
          webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/abc',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )

    const wrapper = await connectToUserChrome()
    expect(wrapper.cdpURL).toBe('http://127.0.0.1:9222')
    expect(wrapper.webSocketDebuggerUrl).toContain('ws://')
    expect(typeof wrapper.isAlive).toBe('function')
    expect(await wrapper.isAlive()).toBe(true)
  })

  it('uses AbortSignal.timeout to avoid hanging on slow ports', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ Browser: 'Chrome/120.0', webSocketDebuggerUrl: 'ws://x' }), {
        status: 200,
      }),
    )

    await connectToUserChrome()

    const call = vi.mocked(globalThis.fetch).mock.calls[0]
    const init = call[1] as RequestInit | undefined
    // AbortSignal 实例（不是 undefined 占位符）— 比 toBeDefined 更具体
    expect(init?.signal).toBeInstanceOf(AbortSignal)
  })
})

describe('attachPlaywrightToCDP', () => {
  it('calls chromium.connectOverCDP with the wrapper cdpURL', async () => {
    const { chromium } = await import('playwright')
    const fakeBrowser = { contexts: () => [] }
    vi.mocked(chromium.connectOverCDP).mockResolvedValue(fakeBrowser as any)

    const wrapper: import('./cdp.js').CDPWrapper = {
      cdpURL: 'http://127.0.0.1:9333',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/browser/abc',
      isAlive: async () => true,
    }

    await attachPlaywrightToCDP(wrapper)
    expect(chromium.connectOverCDP).toHaveBeenCalledWith('http://127.0.0.1:9333', { noDefaults: true })
  })

  it('returns the Playwright Browser instance from connectOverCDP', async () => {
    const { chromium } = await import('playwright')
    const fakeBrowser = { contexts: () => [{ pages: () => [] }] }
    vi.mocked(chromium.connectOverCDP).mockResolvedValue(fakeBrowser as any)

    const wrapper: import('./cdp.js').CDPWrapper = {
      cdpURL: 'http://127.0.0.1:9222',
      webSocketDebuggerUrl: 'ws://x',
      isAlive: async () => true,
    }

    const browser = await attachPlaywrightToCDP(wrapper)
    expect(browser).toBe(fakeBrowser)
  })

  it('uses wrapper.cdpURL exactly (no default substitution)', async () => {
    const { chromium } = await import('playwright')
    vi.mocked(chromium.connectOverCDP).mockResolvedValue({ contexts: () => [] } as any)

    const wrapper: import('./cdp.js').CDPWrapper = {
      cdpURL: 'http://127.0.0.1:9333',
      webSocketDebuggerUrl: 'ws://x',
      isAlive: async () => true,
    }
    await attachPlaywrightToCDP(wrapper)
    const arg = vi.mocked(chromium.connectOverCDP).mock.calls[0][0]
    expect(arg).not.toContain('9222')
  })
})
