// ============================================================
// LLM 适配器单元测试
// ============================================================
// Sprint B-1：业务层测试补齐
//
// 覆盖：
//   1. createLLM 4 供应商 switch 返回正确 adapter
//   2. createLLM 未知 provider 抛错
//   3. OpenAIAdapter.generate 调用 chat.completions.create 并返回 content
//   4. AnthropicAdapter.generate 调用 fetch 并返回 content
//
// Mock 策略：
//   - vi.mock('openai')：mock OpenAI SDK 整个模块
//   - vi.stubGlobal('fetch')：mock Anthropic adapter 用的 fetch
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { AppConfig } from '../types/index.js'

// ============================================================
// Mock OpenAI SDK（在 import createLLM 之前）
// ============================================================

const mockCreate = vi.fn()

// 注意：mock 函数必须用普通 function（不能箭头函数），否则 new OpenAI() 会报 "is not a constructor"
function MockOpenAI(this: any, _opts: unknown) {
  this.chat = {
    completions: {
      create: mockCreate,
    },
  }
}
const MockOpenAISpy = vi.fn(MockOpenAI)

vi.mock('openai', () => ({
  default: MockOpenAISpy,
}))

// ============================================================
// 现在导入被测代码（必须在 mock 之后）
// ============================================================

const { createLLM } = await import('./index.js')

// ============================================================
// 工具：构造最小 AppConfig
// ============================================================

function makeConfig(llmOverrides: Partial<AppConfig['llm']>): AppConfig {
  return {
    feishu: { appId: 'cli_test', appSecret: 'secret_test' },
    llm: {
      provider: 'deepseek',
      // Sprint 1D Phase 2（ADR-0011）：apiKey 默认 'sk-test' 占位
      // baseURL/model 默认 undefined — provider case 各自 fallback 到默认
      apiKey: 'sk-test',
      ...llmOverrides,
    },
    boss: {},
    browser: {},
    scoreThreshold: 0.85,
    scoreWeights: {
      education: 0.1,
      experience: 0.3,
      skill: 0.1,
      project: 0.3,
      stability: 0.1,
      potential: 0.1,
    },
  }
}

describe('createLLM — 供应商 switch', () => {
  beforeEach(() => {
    MockOpenAISpy.mockClear()
    mockCreate.mockReset()
  })

  it('deepseek → OpenAIAdapter，baseURL=https://api.deepseek.com/v1', () => {
    createLLM(makeConfig({ provider: 'deepseek', apiKey: 'sk-ds-test' }))

    expect(MockOpenAISpy).toHaveBeenCalledTimes(1)
    expect(MockOpenAISpy).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'sk-ds-test',
        baseURL: 'https://api.deepseek.com/v1',
      }),
    )
  })

  it('openai → OpenAIAdapter，baseURL=https://api.openai.com/v1', () => {
    createLLM(makeConfig({ provider: 'openai', apiKey: 'sk-oai-test' }))

    expect(MockOpenAISpy).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'sk-oai-test',
        baseURL: 'https://api.openai.com/v1',
      }),
    )
  })

  it('ollama → OpenAIAdapter，baseURL=http://localhost:11434/v1（不需要真实 key）', () => {
    createLLM(makeConfig({ provider: 'ollama', apiKey: 'ollama' }))

    expect(MockOpenAISpy).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'ollama',
        baseURL: 'http://localhost:11434/v1',
      }),
    )
  })

  it('未知 provider → throw', () => {
    expect(() =>
      createLLM(makeConfig({ provider: 'unknown' as any })),
    ).toThrow(/不支持的 LLM 供应商/)
  })

  // ----------------------------------------------------------
  // R8 (B1 / ADR-0012 §6): provider='huoshan' → AnthropicCompatAdapter + Bearer + ark coding
  // ----------------------------------------------------------

  it('R8: provider="huoshan" → AnthropicCompatAdapter (ark coding baseURL + Bearer + glm-5.2)', async () => {
    const fetchSpy = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: () => Promise.resolve({ content: [{ type: 'text', text: 'huoshan 招呼' }] }),
      text: () => Promise.resolve('{"content":[{"type":"text","text":"huoshan 招呼"}]}'),
    } as unknown as Response)
    vi.stubGlobal('fetch', fetchSpy)

    try {
      const adapter = createLLM(makeConfig({ provider: 'huoshan', apiKey: 'ark-test-key' }))
      const result = await adapter.generate('JD 内容')

      expect(result).toBe('huoshan 招呼')

      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
      expect(url).toBe('https://ark.cn-beijing.volces.com/api/coding/v1/messages')
      const headers = init.headers as Record<string, string>
      // ADR-0012 §2.2：huoshan 走 Authorization: Bearer（ANTHROPIC_AUTH_TOKEN），不发 x-api-key
      expect(headers['Authorization']).toBe('Bearer ark-test-key')
      expect(headers['x-api-key']).toBeUndefined()
      expect(headers['anthropic-version']).toBe('2023-06-01')
      expect(init.body).toContain('glm-5.2')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  // ----------------------------------------------------------
  // R1' (B2 / ADR-0012 §6): provider='minimax' → Bearer（原 x-api-key 是 bug）
  // ----------------------------------------------------------

  it('R1: provider="minimax" → AnthropicCompatAdapter (baseURL=https://api.minimaxi.com/anthropic + Bearer)', async () => {
    const fetchSpy = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: () => Promise.resolve({ content: [{ type: 'text', text: 'minimax 招呼' }] }),
      text: () => Promise.resolve('{"content":[{"type":"text","text":"minimax 招呼"}]}'),
    } as unknown as Response)
    vi.stubGlobal('fetch', fetchSpy)

    try {
      const adapter = createLLM(makeConfig({ provider: 'minimax', apiKey: 'sk-minimax-test' }))
      const result = await adapter.generate('JD 内容')

      expect(result).toBe('minimax 招呼')

      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
      expect(url).toBe('https://api.minimaxi.com/anthropic/v1/messages')
      const headers = init.headers as Record<string, string>
      // ADR-0012 §5 E3：minimaxi 官方文档用 ANTHROPIC_AUTH_TOKEN（Bearer），非 x-api-key
      expect(headers['Authorization']).toBe('Bearer sk-minimax-test')
      expect(headers['x-api-key']).toBeUndefined()
      expect(headers['anthropic-version']).toBe('2023-06-01')
      expect(init.body).toContain('MiniMax-M2.7-highspeed')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('OpenAIAdapter.generate', () => {
  beforeEach(() => {
    MockOpenAISpy.mockClear()
    mockCreate.mockReset()
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: '你好，这是生成的招呼' } }],
    })
  })

  it('调用 chat.completions.create 并返回 content', async () => {
    const adapter = createLLM(makeConfig({ provider: 'deepseek' }))

    const result = await adapter.generate('JD 内容', '系统提示')

    expect(result).toBe('你好，这是生成的招呼')
    expect(mockCreate).toHaveBeenCalledTimes(1)
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          { role: 'system', content: '系统提示' },
          { role: 'user', content: 'JD 内容' },
        ],
      }),
    )
  })

  it('system 为 undefined 时不传 system message', async () => {
    const adapter = createLLM(makeConfig({ provider: 'openai' }))

    await adapter.generate('JD 内容')

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [{ role: 'user', content: 'JD 内容' }],
      }),
    )
  })

  it('响应 content 为空时抛错（不再返空串，避免 auto-greet fake green）', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: null }, finish_reason: 'content_filter' }],
    })

    const adapter = createLLM(makeConfig({ provider: 'deepseek' }))

    await expect(adapter.generate('JD')).rejects.toThrow(/OpenAI 兼容 API 返回空内容.*content_filter/)
  })

  it('响应 choices 为空数组时抛错', async () => {
    mockCreate.mockResolvedValueOnce({ choices: [] })

    const adapter = createLLM(makeConfig({ provider: 'deepseek' }))

    await expect(adapter.generate('JD')).rejects.toThrow(/返回空内容/)
  })
})

describe('AnthropicCompatAdapter.generate', () => {
  let fetchSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /** Helper: 构造成功响应的 mock Response */
  function mockOkResponse(body: unknown): Response {
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
    } as unknown as Response
  }

  // R5 (B5 / ADR-0011 §6): anthropic 默认 baseURL=https://api.anthropic.com 调 /v1/messages
  it('R5: anthropic 默认 baseURL → fetch https://api.anthropic.com/v1/messages (x-api-key + anthropic-version header)', async () => {
    fetchSpy.mockResolvedValueOnce(
      mockOkResponse({
        content: [{ type: 'text', text: 'Anthropic 生成的招呼' }],
      }),
    )

    const adapter = createLLM(makeConfig({ provider: 'anthropic', apiKey: 'sk-ant-test' }))

    const result = await adapter.generate('JD 内容', '系统提示')

    expect(result).toBe('Anthropic 生成的招呼')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.anthropic.com/v1/messages')
    expect(init.method).toBe('POST')
    const headers = init.headers as Record<string, string>
    // ADR-0012 §2.2：anthropic 官方保持 x-api-key（原生 API 标准），不发 Authorization
    expect(headers['x-api-key']).toBe('sk-ant-test')
    expect(headers['Authorization']).toBeUndefined()
    expect(headers['anthropic-version']).toBe('2023-06-01')
  })

  // R5-supplement: AnthropicCompatAdapter 接受显式 baseURL（minimax → Bearer / ADR-0012 §2.2）
  it('R5-supplement: 显式 baseURL=https://api.minimaxi.com/anthropic → fetch 走 minimax 端点 (Bearer)', async () => {
    fetchSpy.mockResolvedValueOnce(
      mockOkResponse({ content: [{ type: 'text', text: 'minimax 招呼' }] }),
    )

    const adapter = createLLM(
      makeConfig({
        provider: 'minimax',
        apiKey: 'sk-minimax-test',
        baseURL: 'https://api.minimaxi.com/anthropic',
        model: 'MiniMax-M2.7-highspeed',
      }),
    )

    await adapter.generate('JD 内容')

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.minimaxi.com/anthropic/v1/messages')
    const headers = init.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer sk-minimax-test')
    expect(headers['x-api-key']).toBeUndefined()
    expect(init.body).toContain('MiniMax-M2.7-highspeed')
  })

  // R9 (B4 / ADR-0012 §6): huoshan 错误路径 → throw（Bearer 路径不新增错误边界）
  it('R9: huoshan 空内容 → throw（复用空内容 throw 纪律，Bearer 不改错误边界）', async () => {
    fetchSpy.mockResolvedValueOnce(mockOkResponse({ content: [] }))

    const adapter = createLLM(makeConfig({ provider: 'huoshan', apiKey: 'ark-test-key' }))

    await expect(adapter.generate('JD')).rejects.toThrow(/Anthropic 返回空内容/)
  })

  it('R9: huoshan HTTP 401 → throw', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      json: () => Promise.reject(new Error('not json')),
      text: () => Promise.resolve('{"error":"invalid token"}'),
    } as unknown as Response)

    const adapter = createLLM(makeConfig({ provider: 'huoshan', apiKey: 'ark-test-key' }))

    await expect(adapter.generate('JD')).rejects.toThrow(/HTTP 401/)
  })

  // ----------------------------------------------------------------
  // 审计修复后行为变更：旧版返空字符串，新版必须抛错
  // （防止 auto-greet 把空招呼语当成功发给 BOSS HR）
  // ----------------------------------------------------------------
  it('content 缺失时抛错（不再返空串，避免 auto-greet fake green）', async () => {
    fetchSpy.mockResolvedValueOnce(mockOkResponse({ content: [] }))

    const adapter = createLLM(makeConfig({ provider: 'anthropic' }))

    await expect(adapter.generate('JD')).rejects.toThrow(/Anthropic 返回空内容/)
  })

  // R10 (ADR-0012 §10 live 发现): 推理模型（glm-5.2 等）content[0] 是 thinking 块，
  // 必须跳过 thinking 提取 type==='text' 块（否则误判空内容）
  it('R10: content[0]=thinking + content[1]=text（推理模型）→ 提取 text 块', async () => {
    fetchSpy.mockResolvedValueOnce(
      mockOkResponse({
        content: [
          { type: 'thinking', thinking: '让我想想...' },
          { type: 'text', text: '我在线，我是 glm-5.2' },
        ],
      }),
    )

    const adapter = createLLM(makeConfig({ provider: 'huoshan', apiKey: 'ark-test-key' }))

    const result = await adapter.generate('确认在线')
    expect(result).toBe('我在线，我是 glm-5.2')
  })

  it('R10: 多个 text 块 → 拼接', async () => {
    fetchSpy.mockResolvedValueOnce(
      mockOkResponse({
        content: [
          { type: 'thinking', thinking: '思考' },
          { type: 'text', text: '第一段' },
          { type: 'text', text: '第二段' },
        ],
      }),
    )

    const adapter = createLLM(makeConfig({ provider: 'huoshan', apiKey: 'ark-test-key' }))

    const result = await adapter.generate('生成')
    expect(result).toBe('第一段第二段')
  })

  it('R10: 只有 thinking 块无 text 块 → 抛空内容错', async () => {
    fetchSpy.mockResolvedValueOnce(
      mockOkResponse({ content: [{ type: 'thinking', thinking: '只想不说' }] }),
    )

    const adapter = createLLM(makeConfig({ provider: 'huoshan', apiKey: 'ark-test-key' }))

    await expect(adapter.generate('JD')).rejects.toThrow(/Anthropic 返回空内容/)
  })

  it('Anthropic 错误响应（type=error）抛错', async () => {
    fetchSpy.mockResolvedValueOnce(
      mockOkResponse({
        type: 'error',
        error: { type: 'rate_limit_error', message: 'Too many requests' },
      }),
    )

    const adapter = createLLM(makeConfig({ provider: 'anthropic' }))

    await expect(adapter.generate('JD')).rejects.toThrow(/rate_limit_error.*Too many requests/)
  })

  it('HTTP 401/500 抛错（不再伪装成功）', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      json: () => Promise.reject(new Error('not json')),
      text: () => Promise.resolve('{"error":"invalid api key"}'),
    } as unknown as Response)

    const adapter = createLLM(makeConfig({ provider: 'anthropic' }))

    await expect(adapter.generate('JD')).rejects.toThrow(/HTTP 401/)
  })
})