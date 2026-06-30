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
  CDPUnavailableError,
  getChromeLaunchInstructions,
} from './cdp.js'

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
    expect(init?.signal).toBeDefined()
  })
})
