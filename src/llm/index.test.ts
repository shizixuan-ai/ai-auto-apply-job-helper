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
      deepseekApiKey: 'sk-ds-test',
      openaiApiKey: 'sk-oai-test',
      anthropicApiKey: 'sk-ant-test',
      ollamaBaseUrl: 'http://localhost:11434',
      ollamaModel: 'llama3',
      ...llmOverrides,
    },
    boss: {},
    browser: {},
  }
}

describe('createLLM — 供应商 switch', () => {
  beforeEach(() => {
    MockOpenAISpy.mockClear()
    mockCreate.mockReset()
  })

  it('deepseek → OpenAIAdapter，baseURL=https://api.deepseek.com/v1', () => {
    createLLM(makeConfig({ provider: 'deepseek' }))

    expect(MockOpenAISpy).toHaveBeenCalledTimes(1)
    expect(MockOpenAISpy).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'sk-ds-test',
        baseURL: 'https://api.deepseek.com/v1',
      }),
    )
  })

  it('openai → OpenAIAdapter，baseURL=https://api.openai.com/v1', () => {
    createLLM(makeConfig({ provider: 'openai' }))

    expect(MockOpenAISpy).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'sk-oai-test',
        baseURL: 'https://api.openai.com/v1',
      }),
    )
  })

  it('ollama → OpenAIAdapter，baseURL=http://localhost:11434/v1（不需要真实 key）', () => {
    createLLM(makeConfig({ provider: 'ollama' }))

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

describe('AnthropicAdapter.generate', () => {
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

  it('调用 fetch 并返回 content[0].text', async () => {
    fetchSpy.mockResolvedValueOnce(
      mockOkResponse({
        content: [{ type: 'text', text: 'Anthropic 生成的招呼' }],
      }),
    )

    const adapter = createLLM(makeConfig({ provider: 'anthropic' }))

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