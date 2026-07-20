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
  const { provider, apiKey, baseURL, model } = config.llm
  switch (provider) {
    case 'deepseek':
      return new OpenAIAdapter({
        apiKey: apiKey ?? '',
        baseURL: baseURL ?? 'https://api.deepseek.com/v1',
        model: model ?? 'deepseek-chat',
      })
    case 'openai':
      return new OpenAIAdapter({
        apiKey: apiKey ?? '',
        baseURL: baseURL ?? 'https://api.openai.com/v1',
        model: model ?? 'gpt-4o',
      })
    case 'anthropic':
      return new AnthropicCompatAdapter({
        apiKey: apiKey ?? '',
        baseURL: baseURL ?? 'https://api.anthropic.com',
        model: model ?? 'claude-sonnet-4-20250514',
      })
    case 'ollama':
      return new OpenAIAdapter({
        apiKey: apiKey ?? 'ollama', // Ollama 不需要真实 key
        baseURL: baseURL ?? 'http://localhost:11434/v1',
        model: model ?? 'llama3',
      })
    case 'minimax':
      // Sprint 1D Phase 3（ADR-0011 §9.5）：Anthropic 协议端点
      // baseURL 走 Anthropic 协议路径（不是 /v1），URL 字面证据 H1
      return new AnthropicCompatAdapter({
        apiKey: apiKey ?? '',
        baseURL: baseURL ?? 'https://api.minimaxi.com/anthropic',
        model: model ?? 'MiniMax-M2.7-highspeed',
      })
    case 'huoshan':
      // 火山方舟 coding plan 协议未确认（等 user 提供 URL + protocol + model）
      throw new Error(
        'LLM 供应商 huoshan 尚未配置（等火山方舟 coding plan 协议确认后再启用，详见 ADR-0011 §10）',
      )
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

    // 审计修复（穷尽审计发现）：与 Anthropic 同样的 fake green 漏洞
    // content=null/空 时返 '' → auto-greet 把空招呼语当成功发给 BOSS HR
    const text = res.choices[0]?.message?.content
    if (typeof text !== 'string' || text.length === 0) {
      const finishReason = res.choices[0]?.finish_reason
      throw new Error(
        `OpenAI 兼容 API 返回空内容 [model=${this.model}, finish_reason=${finishReason}]: ` +
        JSON.stringify(res).slice(0, 200),
      )
    }
    return text
  }
}

// ============================================================
// Anthropic 协议兼容适配器（Sprint 1D Phase 3 / ADR-0011 §2.2）
// ============================================================
// 通用化 baseURL：覆盖 Anthropic 官方 + 任何走 /v1/messages + x-api-key 的兼容端点
//   - Anthropic 官方:    https://api.anthropic.com
//   - MiniMax:           https://api.minimaxi.com/anthropic（URL 字面证据 H1）
//   - 未来其他兼容供应商: 由 createLLM switch case 传入
//
// 错误处理：沿用 ADR-0010 空内容 throw 纪律（fake green 防御）
// ============================================================

export class AnthropicCompatAdapter implements LLMAdapter {
  private apiKey: string
  private baseURL: string
  private model: string

  constructor(opts: { apiKey: string; baseURL: string; model: string }) {
    this.apiKey = opts.apiKey
    this.baseURL = opts.baseURL
    this.model = opts.model
  }

  async generate(prompt: string, system?: string): Promise<string> {
    const res = await fetch(`${this.baseURL}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.model,
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
