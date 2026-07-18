// ============================================================
// src/browser/boss-ws/proxy.test.ts — Sprint 2026-07-13 PoC RED
// ============================================================
// 不依赖 jsdom：手动注入 MockWebSocket 当 globalThis.WebSocket。

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------- MockWebSocket ----------

type WSListener = (e: { data: unknown }) => void

class MockWebSocket {
  static instances: MockWebSocket[] = []
  url: string
  onmessage: ((e: { data: unknown }) => void) | null = null
  private listeners = new Map<string, WSListener[]>()
  send = vi.fn()

  constructor(url: string) {
    this.url = url
    MockWebSocket.instances.push(this)
  }

  addEventListener(type: string, fn: WSListener) {
    const arr = this.listeners.get(type) ?? []
    arr.push(fn)
    this.listeners.set(type, arr)
  }

  close() {}

  /** 模拟 Boss 推消息 */
  simulateMessage(data: unknown) {
    // 触发包一层后的 onmessage
    if (this.onmessage) this.onmessage({ data })
    // 同时分发 listener
    for (const fn of this.listeners.get('message') ?? []) {
      fn({ data })
    }
  }
}

// ---------- 注入 mock ----------

beforeEach(() => {
  MockWebSocket.instances = []
  ;(globalThis as unknown as { WebSocket: unknown }).WebSocket =
    MockWebSocket as unknown
})

// ---------- RED tests ----------

describe('WebSocketProxy — PoC RED', () => {
  it('RED gate: 动态 import 模块必须存在', async () => {
    const mod = await import('./proxy.js')
    expect(typeof mod.activate).toBe('function')
    expect(typeof mod.isHooked).toBe('function')
  })

  it('case 1: activate 后 globalThis.WebSocket 被替换为代理类', async () => {
    const { activate } = await import('./proxy.js')
    const OriginalWS = (globalThis as unknown as { WebSocket: unknown }).WebSocket
    activate({ shouldHook: () => true })
    expect((globalThis as unknown as { WebSocket: unknown }).WebSocket).not.toBe(
      OriginalWS,
    )
  })

  it('case 2: shouldHook=false 时不进入 hookMap', async () => {
    const { activate, isHooked, _reset } = await import('./proxy.js')
    _reset()
    activate({ shouldHook: () => false })
    const WS = (globalThis as unknown as { WebSocket: new (url: string) => unknown }).WebSocket
    new WS('wss://chat.zhipin.com/x')
    expect(isHooked('wss://chat.zhipin.com/x')).toBe(false)
  })

  it('case 3: shouldHook=true 时 url 进入 hookMap 实例被存', async () => {
    const { activate, isHooked, _reset } = await import('./proxy.js')
    _reset()
    activate({ shouldHook: (u) => u.includes('chat') })
    const WS = (globalThis as unknown as { WebSocket: new (url: string) => unknown }).WebSocket
    new WS('wss://chat.zhipin.com/x')
    expect(isHooked('wss://chat.zhipin.com/x')).toBe(true)
  })

  it('case 4: onmessage setter 装上拦截器，触发时调用 onMessage 一次', async () => {
    const { activate, _reset } = await import('./proxy.js')
    _reset()
    const onMessage = vi.fn((data) => `wrapped:${(data as { v: number }).v}`)
    activate({
      shouldHook: () => true,
      onMessage,
    })

    // 重新拿代理类（已替换 globalThis.WebSocket）
    const ProxyWS = (globalThis as unknown as { WebSocket: unknown })
      .WebSocket as unknown as new (url: string) => MockWebSocket
    const ws = new ProxyWS('wss://chat.zhipin.com/y')
    // 设置 onmessage（触发 setter 包一层）
    ws.onmessage = (e: { data: unknown }) => {
      expect(e.data).toBe('wrapped:42')
    }
    // 模拟 BOSS 推一条消息
    ws.simulateMessage({ v: 42 })
    expect(onMessage).toHaveBeenCalledTimes(1)
    expect(onMessage).toHaveBeenCalledWith({ v: 42 })
  })

  it('case 5: send 被重写 + onSend 拦截器包装', async () => {
    const { activate, _reset } = await import('./proxy.js')
    _reset()
    const onSend = vi.fn((d) => ({ wrapped: d }))
    activate({ shouldHook: () => true, onSend })

    const ProxyWS = (globalThis as unknown as { WebSocket: unknown })
      .WebSocket as unknown as new (url: string) => MockWebSocket
    const ws = new ProxyWS('wss://chat.zhipin.com/z')
    ws.send({ raw: 1 })
    expect(onSend).toHaveBeenCalledWith({ raw: 1 })
  })
})
