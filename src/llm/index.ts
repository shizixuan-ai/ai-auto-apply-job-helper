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

    // 审计修复（用户实测暴露 fake green 风险）：
    // 旧代码不检查 res.ok 和 body.type === 'error'，错误时返空串 ''
    // → auto-greet 把空招呼语发给 BOSS HR，sync 标『已投递』但实际无效
    if (!res.ok) {
      const errBody = await res.text().catch(() => '')
      throw new Error(`Anthropic HTTP ${res.status}: ${res.statusText} ${errBody.slice(0, 200)}`)
    }

    const body = await res.json()

    // Anthropic 错误响应格式：{ type: 'error', error: { type, message } }
    if (body?.type === 'error') {
      throw new Error(`Anthropic API 错误 [${body.error?.type}]: ${body.error?.message}`)
    }

    const text = body?.content?.[0]?.text
    if (typeof text !== 'string' || text.length === 0) {
      throw new Error(`Anthropic 返回空内容: ${JSON.stringify(body).slice(0, 200)}`)
    }
    return text
  }
}
