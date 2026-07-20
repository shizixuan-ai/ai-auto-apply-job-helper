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
  // R2 (B2 / ADR-0011 §6): provider='huoshan' → throw "尚未配置"
  // ----------------------------------------------------------

  it('R2: provider="huoshan" → throw 含"尚未配置"提示', () => {
    expect(() =>
      createLLM(makeConfig({ provider: 'huoshan' })),
    ).toThrow(/huoshan 尚未配置.*ADR-0011/)
  })

  // ----------------------------------------------------------
  // R1 (B1 / ADR-0011 §6): provider='minimax' → AnthropicCompatAdapter + minimax baseURL
  // ----------------------------------------------------------

  it('R1: provider="minimax" → AnthropicCompatAdapter (baseURL=https://api.minimaxi.com/anthropic)', async () => {
    // fetch mock 验 URL 走 minimax 端点（行为契约验证，不用 instanceof）
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
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://api.minimaxi.com/anthropic/v1/messages',
        expect.objectContaining({
          headers: expect.objectContaining({
            'x-api-key': 'sk-minimax-test',
            'anthropic-version': '2023-06-01',
          }),
          body: expect.stringContaining('MiniMax-M2.7-highspeed'),
        }),
      )
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
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/messages',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'x-api-key': 'sk-ant-test',
          'anthropic-version': '2023-06-01',
        }),
      }),
    )
  })

  // R5 补充: AnthropicCompatAdapter 接受显式 baseURL（minimax 等非默认场景）
  it('R5-supplement: 显式 baseURL=https://api.minimaxi.com/anthropic → fetch 走 minimax 端点', async () => {
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

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.minimaxi.com/anthropic/v1/messages',
      expect.objectContaining({
        headers: expect.objectContaining({ 'x-api-key': 'sk-minimax-test' }),
        body: expect.stringContaining('MiniMax-M2.7-highspeed'),
      }),
    )
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