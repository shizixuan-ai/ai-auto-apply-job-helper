// ============================================================
// src/browser/boss-ws/proxy.ts — Sprint 2026-07-13 PoC
// ============================================================
// 浏览器端 WebSocket 构造函数劫持：
//   - 仅对含 'chat' 子串的 URL 装上 hook（决策 1：@match chat）
//   - hookMap 防止重复注册
//   - onmessage setter 重写：包一层拦截二进制消息
//   - send() 重写：包一层（PoC 仅观察，pass-through 不修改发送数据）
//
// 测试策略：RED 先写测试，jsdom 默认不实现 WebSocket，
//   所以在 beforeEach 里 mock globalThis.WebSocket = MockWebSocket。
// ============================================================

/** 拦截器配置 */
export interface ProxyOptions {
  /** URL 过滤。返回 true 才装 hook（决策 1 限 chat） */
  shouldHook: (url: string) => boolean
  /** onmessage 拦截器：raw 二进制 → 处理后（保持原类型或转对象） */
  onMessage?: (data: unknown) => unknown
  /** send 拦截器：被发送数据 → 修改后版本（PoC 不开启） */
  onSend?: (data: unknown) => unknown
}

/** hookMap：url → WebSocketProxy 实例（防重复） */
const hookMap = new Map<string, unknown>()

/** 当前激活的配置（运行时单例） */
let activeOptions: ProxyOptions | null = null

/** WebSocket 代理类：从原生 WebSocket 继承 + 重写 onmessage/send */
export class WebSocketProxy extends globalThis.WebSocket {
  static get hookMap(): Map<string, unknown> {
    return hookMap
  }

  constructor(url: string | URL, protocols?: string | string[]) {
    super(url, protocols)
    if (!activeOptions) return
    const urlStr = String(url)
    if (!activeOptions.shouldHook(urlStr)) return
    if (hookMap.has(urlStr)) return
    hookMap.set(urlStr, this)

    // 重写 onmessage setter —— 包一层拦截
    Object.defineProperty(this, 'onmessage', {
      configurable: true,
      set: (fn: ((e: MessageEvent) => void) | null) => {
        if (!fn) return
        this.addEventListener('message', (e: MessageEvent) => {
          const out = activeOptions!.onMessage
            ? activeOptions!.onMessage(e.data)
            : e.data
          fn.call(this, new MessageEvent('message', { data: out }))
        })
      },
    })

    // 重写 send —— 包一层（PoC 不修改发送数据）
    const originalSend = this.send.bind(this)
    this.send = (data: unknown) => {
      const out = activeOptions!.onSend
        ? activeOptions!.onSend(data)
        : data
      // WebSocket.send 接受 string | Blob | ArrayBufferLike | ArrayBufferView
      // 拦截器返回 unknown —— 信任调用方契约（PoC 阶段只 pass-through）
      ;(originalSend as (d: unknown) => void)(out)
    }
  }
}

/** 激活 hook：保存 options + 用代理类替换全局 WebSocket */
export function activate(options: ProxyOptions): void {
  activeOptions = options
  ;(globalThis as { WebSocket: unknown }).WebSocket = WebSocketProxy as unknown
}

/** 仅供测试用：清空状态 */
export function _reset(): void {
  hookMap.clear()
  activeOptions = null
  // 还原全局 WebSocket 在测试里手动处理
}

/** 供测试用：判断 url 是否已 hook */
export function isHooked(url: string): boolean {
  return hookMap.has(url)
}
