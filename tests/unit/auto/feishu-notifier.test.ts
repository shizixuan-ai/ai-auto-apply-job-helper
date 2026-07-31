// ============================================================
// tests/unit/auto/feishu-notifier.test.ts — Sprint E-1 §13 RED 7 tests
// ------------------------------------------------------------
// 状态: RED (待 src/auto/feishu-notifier.ts GREEN 实现)
// 覆盖: T34-T40 (per ADR-0016 §13 E-1 收尾 + 架构师 review 反馈)
//       T34: formatFeishuText 输出 + JSON body shape
//       T35: 基础 POST — 200 + body {code:0} → 1 call + resolve
//       T36: 5xx retry success — 500 → 200+code:0 → 2 calls + 1 sleep=1000ms
//       T37: 5xx all fail — 3 attempts 全 500 → 3 calls + 2 sleeps + 1 warn + no throw
//       T38: 4xx no retry — 400 → 1 call + 0 sleep + 1 warn + no throw
//       T39: [架构师 review 必修正] 飞书 webhook 200 + body code !== 0 (e.g. 19001)
//              → 不重试 (URL 无效重试无效) + 1 call + 0 sleep + 1 warn + no throw
//       T40: [架构师 review 强烈建议] msg > 19000 字符 → 截断到 19000 + '...(truncated)' 后缀
// 纪律: §3.13 错误分层 (warnLogger msg 前缀 [FEISHU]); §3.9 不变量 (notify 永不 throw);
//       §3.12 mock fetch 注入 (避免真实网络); §3.10 (新模块, 新 export, 0 caller 改动)
// 单账号红线守住: 0 触碰 BOSS (feishu webhook ≠ BOSS, mock 完全 inject)
// ============================================================

import { describe, it, expect, vi } from 'vitest'
import {
  formatFeishuText,
  createFeishuNotifier,
  type FeishuNotifierOpts,
} from '../../../src/auto/feishu-notifier'

/** Mock fetch 工厂:按 sequence 返回不同 Response */
function makeMockFetch(responses: Array<{
  status?: number
  body?: object | string
}>): typeof fetch & { calls: Array<{ url: string; body: string }> } {
  let idx = 0
  const calls: Array<{ url: string; body: string }> = []
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: String(init?.body ?? '') })
    const r = responses[idx++] ?? responses[responses.length - 1]
    return new Response(
      typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? { code: 0 }),
      { status: r.status ?? 200, headers: { 'Content-Type': 'application/json' } },
    )
  }) as unknown as typeof fetch & { calls: typeof calls }
  fn.calls = calls
  return fn
}

/** Test notifier factory: 注入 mock fetch + 记录 sleep + 记录 warn */
function makeTestNotifier(
  mockFetch: ReturnType<typeof makeMockFetch>,
  opts?: Partial<FeishuNotifierOpts>,
) {
  const sleeps: number[] = []
  const warns: string[] = []
  const notifier = createFeishuNotifier({
    webhookUrl: 'https://open.feishu.cn/hook/test',
    maxRetries: 3,
    initialBackoffMs: 1000,
    timeoutMs: 5000,
    fetch: mockFetch,
    sleep: async (ms) => { sleeps.push(ms) },
    warnLogger: (m) => warns.push(m),
    ...opts,
  })
  return { notifier, sleeps, warns }
}

// ─── T34: formatFeishuText 直接单元 (无网络) ─────────────────────
describe('T34: formatFeishuText + JSON body shape', () => {
  it('warn level → 🟡 [WARN] prefix', () => {
    expect(formatFeishuText('warn', 'msg')).toBe('🟡 [WARN] msg')
  })

  it('critical level → 🔴 [CRITICAL] prefix', () => {
    expect(formatFeishuText('critical', '风控触发 anti_bot')).toBe(
      '🔴 [CRITICAL] 风控触发 anti_bot',
    )
  })

  it('msg > 19000 chars → truncated to 19000 + ...(truncated) suffix', () => {
    const longMsg = 'x'.repeat(25000)
    const out = formatFeishuText('warn', longMsg)
    expect(out.length).toBeLessThanOrEqual(19200)  // tag (~16) + 19000 + suffix (~14)
    expect(out.endsWith('...(truncated)')).toBe(true)
    expect(out.startsWith('🟡 [WARN] ')).toBe(true)
  })

  it('msg ≤ 19000 chars → not truncated', () => {
    const msg = 'short msg'
    const out = formatFeishuText('critical', msg)
    expect(out).toBe(`🔴 [CRITICAL] ${msg}`)
    expect(out.includes('...(truncated)')).toBe(false)
  })
})

// ─── T35: 基础 POST — 200 + code:0 → 1 call + no warn ────────────
describe('T35: basic POST success (200 + code:0)', () => {
  it('1 fetch call, 0 sleep, 0 warn, no throw', async () => {
    const fetchMock = makeMockFetch([{ status: 200, body: { code: 0, msg: 'success' } }])
    const { notifier, sleeps, warns } = makeTestNotifier(fetchMock)
    await expect(notifier.notify('critical', '[AUTO.guard] 风控触发')).resolves.toBeUndefined()
    expect(fetchMock.calls).toHaveLength(1)
    expect(sleeps).toEqual([])
    expect(warns).toEqual([])
    // 验证 body 格式
    const body = JSON.parse(fetchMock.calls[0].body)
    expect(body.msg_type).toBe('text')
    expect(body.content.text).toBe('🔴 [CRITICAL] [AUTO.guard] 风控触发')
  })
})

// ─── T36: 5xx retry success path ────────────────────────────────
describe('T36: 5xx retry success (500 → 200+code:0)', () => {
  it('2 calls, 1 sleep=1000ms, no warn, no throw', async () => {
    const fetchMock = makeMockFetch([
      { status: 500 },  // 1st: 5xx
      { status: 200, body: { code: 0, msg: 'success' } },  // 2nd: success
    ])
    const { notifier, sleeps, warns } = makeTestNotifier(fetchMock)
    await expect(notifier.notify('warn', 'retry test')).resolves.toBeUndefined()
    expect(fetchMock.calls).toHaveLength(2)
    expect(sleeps).toEqual([1000])  // 一次 1000ms (after 1st failed attempt)
    expect(warns).toEqual([])
  })

  it('maxRetries=2: 1st 503 → 2nd 200 → 2 calls, 1 sleep=500ms', async () => {
    const fetchMock = makeMockFetch([
      { status: 503 },
      { status: 200, body: { code: 0, msg: 'ok' } },
    ])
    const { notifier, sleeps, warns } = makeTestNotifier(fetchMock, {
      maxRetries: 2,
      initialBackoffMs: 500,
    })
    await notifier.notify('critical', 'maxRetries=2')
    expect(fetchMock.calls).toHaveLength(2)
    expect(sleeps).toEqual([500])
    expect(warns).toEqual([])
  })
})

// ─── T37: 5xx all fail (3 attempts) ─────────────────────────────
describe('T37: 5xx all fail after 3 attempts', () => {
  it('3 calls, 2 sleeps=[1000,2000], 1 warn msg, no throw', async () => {
    const fetchMock = makeMockFetch([
      { status: 500 }, { status: 503 }, { status: 500 },
    ])
    const { notifier, sleeps, warns } = makeTestNotifier(fetchMock)
    await expect(notifier.notify('critical', 'all fail')).resolves.toBeUndefined()
    expect(fetchMock.calls).toHaveLength(3)
    expect(sleeps).toEqual([1000, 2000])  // 指数退避: 1000*2^0 + 1000*2^1
    expect(warns).toHaveLength(1)
    expect(warns[0]).toMatch(/3\/3 attempts failed/)
    expect(warns[0]).toMatch(/HTTP 500/)  // 最后一次错(HTTP 500)
  })

  it('backoff timing: initialBackoffMs × 2^attempt (custom initial)', async () => {
    const fetchMock = makeMockFetch([
      { status: 500 }, { status: 500 }, { status: 500 },
    ])
    const { notifier, sleeps } = makeTestNotifier(fetchMock, {
      maxRetries: 3,
      initialBackoffMs: 100,  // base 100
    })
    await notifier.notify('warn', 'timing')
    expect(sleeps).toEqual([100, 200])  // 100 × 2^0 + 100 × 2^1
    expect(fetchMock.calls).toHaveLength(3)
  })
})

// ─── T38: 4xx no retry (per 架构师 review: 客户端错误不应重发) ──
describe('T38: 4xx no retry', () => {
  it('HTTP 400 → 1 call (no retry), 0 sleep, 1 warn, no throw', async () => {
    const fetchMock = makeMockFetch([{ status: 400, body: 'Bad Request' }])
    const { notifier, sleeps, warns } = makeTestNotifier(fetchMock)
    await expect(notifier.notify('warn', 'client error')).resolves.toBeUndefined()
    expect(fetchMock.calls).toHaveLength(1)  // 仅 1 次,不重试
    expect(sleeps).toEqual([])
    expect(warns).toHaveLength(1)
    expect(warns[0]).toMatch(/HTTP 400/)
  })

  it('HTTP 404 → 1 call, 1 warn (no retry)', async () => {
    const fetchMock = makeMockFetch([{ status: 404 }])
    const { notifier, sleeps, warns } = makeTestNotifier(fetchMock)
    await notifier.notify('critical', 'not found')
    expect(fetchMock.calls).toHaveLength(1)
    expect(sleeps).toEqual([])
    expect(warns).toHaveLength(1)
  })
})

// ─── T39: [架构师 review 必修正] 飞书 webhook 业务失败 ──────────
describe('T39: feishu business error (HTTP 200 + body code !== 0)', () => {
  it('code=19001 (invalid webhook url) → no retry (URL invalid), 1 call, 0 sleep, 1 warn, no throw', async () => {
    const fetchMock = makeMockFetch([
      { status: 200, body: { code: 19001, msg: 'invalid webhook url' } },
    ])
    const { notifier, sleeps, warns } = makeTestNotifier(fetchMock)
    await expect(notifier.notify('critical', 'url invalid')).resolves.toBeUndefined()
    expect(fetchMock.calls).toHaveLength(1)  // 仅 1 次,不重试
    expect(sleeps).toEqual([])
    expect(warns).toHaveLength(1)
    expect(warns[0]).toMatch(/code=19001/)
    expect(warns[0]).toMatch(/invalid webhook url/)
  })

  it('code=230001 (msg too long) → same behavior: no retry, 1 warn', async () => {
    const fetchMock = makeMockFetch([
      { status: 200, body: { code: 230001, msg: 'msg too long' } },
    ])
    const { notifier, sleeps, warns } = makeTestNotifier(fetchMock)
    await notifier.notify('warn', 'too long')
    expect(fetchMock.calls).toHaveLength(1)
    expect(sleeps).toEqual([])
    expect(warns[0]).toMatch(/code=230001/)
  })
})

// ─── T40: 端到端 msg 长度截断 (走 mock fetch 验证 body) ─────────
describe('T40: end-to-end msg length truncation (in POST body)', () => {
  it('25000-char msg → fetch receives truncated text', async () => {
    const fetchMock = makeMockFetch([{ status: 200, body: { code: 0, msg: 'ok' } }])
    const longMsg = 'x'.repeat(25000)
    const { notifier } = makeTestNotifier(fetchMock)
    await notifier.notify('warn', longMsg)
    expect(fetchMock.calls).toHaveLength(1)
    const sentText = JSON.parse(fetchMock.calls[0].body).content.text
    expect(sentText.length).toBeLessThanOrEqual(19200)
    expect(sentText.endsWith('...(truncated)')).toBe(true)
  })
})
