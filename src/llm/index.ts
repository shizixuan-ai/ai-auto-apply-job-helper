// ============================================================
// LLM 适配器 — 多供应商切换
// ============================================================
// 使用适配器模式，通过 provider 字段选择对应实现。
// 所有供应商统一返回 { content: string } 格式。
// ============================================================

import OpenAI from 'openai'
import type { LLMProvider, AppConfig } from '../types/index.js'

/** LLM 适配器统一接口 */
export interface LLMAdapter {
  generate(prompt: string, system?: string): Promise<string>
}

/** 创建适配合适的 LLM 适配器 */
export function createLLM(config: AppConfig): LLMAdapter {
  const provider = config.llm.provider
  switch (provider) {
    case 'deepseek':
      return new OpenAIAdapter({
        apiKey: config.llm.deepseekApiKey ?? '',
        baseURL: 'https://api.deepseek.com/v1',
        model: 'deepseek-chat',
      })
    case 'openai':
      return new OpenAIAdapter({
        apiKey: config.llm.openaiApiKey ?? '',
        baseURL: 'https://api.openai.com/v1',
        model: 'gpt-4o',
      })
    case 'anthropic':
      return new AnthropicAdapter(config.llm.anthropicApiKey ?? '')
    case 'ollama':
      return new OpenAIAdapter({
        apiKey: 'ollama', // Ollama 不需要真实 key
        baseURL: `${config.llm.ollamaBaseUrl ?? 'http://localhost:11434'}/v1`,
        model: config.llm.ollamaModel ?? 'llama3',
      })
    default:
      throw new Error(`不支持的 LLM 供应商: ${provider}`)
  }
}

// ============================================================
// OpenAI 兼容适配器（DeepSeek / OpenAI / Ollama）
// ============================================================

class OpenAIAdapter implements LLMAdapter {
  private client: OpenAI
  private model: string

  constructor(opts: { apiKey: string; baseURL: string; model: string }) {
    this.client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseURL })
    this.model = opts.model
  }

  async generate(prompt: string, system?: string): Promise<string> {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = []
    if (system) {
      messages.push({ role: 'system', content: system })
    }
    messages.push({ role: 'user', content: prompt })

    const res = await this.client.chat.completions.create({
      model: this.model,
      messages,
      temperature: 0.7,
    })

    return res.choices[0]?.message?.content ?? ''
  }
}

// ============================================================
// Anthropic Claude 适配器
// ============================================================

class AnthropicAdapter implements LLMAdapter {
  private apiKey: string

  constructor(apiKey: string) {
    this.apiKey = apiKey
  }

  async generate(prompt: string, system?: string): Promise<string> {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        system,
        messages: [{ role: 'user', content: prompt }],
      }),
    })

    const body = await res.json()
    return (body as any).content?.[0]?.text ?? ''
  }
}
