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
        authStyle: 'x-api-key', // Anthropic 原生 API 标准（ADR-0012 §2.2）
      })
    case 'ollama':
      return new OpenAIAdapter({
        apiKey: apiKey ?? 'ollama', // Ollama 不需要真实 key
        baseURL: baseURL ?? 'http://localhost:11434/v1',
        model: model ?? 'llama3',
      })
    case 'minimax':
      // Sprint 1D Phase 3（ADR-0011 §9.5）：Anthropic 协议端点
      // ADR-0012 §5 E3：minimaxi 官方文档用 ANTHROPIC_AUTH_TOKEN（Bearer），非 x-api-key（原实现是 bug）
      return new AnthropicCompatAdapter({
        apiKey: apiKey ?? '',
        baseURL: baseURL ?? 'https://api.minimaxi.com/anthropic',
        model: model ?? 'MiniMax-M2.7-highspeed',
        authStyle: 'bearer',
      })
    case 'huoshan':
      // ADR-0012：火山方舟 coding plan = Anthropic 协议 + Bearer 鉴权（ANTHROPIC_AUTH_TOKEN）
      return new AnthropicCompatAdapter({
        apiKey: apiKey ?? '',
        baseURL: baseURL ?? 'https://ark.cn-beijing.volces.com/api/coding',
        model: model ?? 'glm-5.2',
        authStyle: 'bearer',
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
// Anthropic 协议兼容适配器（Sprint 1D Phase 3 / ADR-0011 §2.2 + ADR-0012）
// ============================================================
// 通用化 baseURL + authStyle：覆盖 Anthropic 官方 + 任何走 /v1/messages 的兼容端点
//   - Anthropic 官方:    https://api.anthropic.com          authStyle='x-api-key'
//   - minimax:           https://api.minimaxi.com/anthropic  authStyle='bearer'（ADR-0012 §5 E3）
//   - huoshan(火山方舟):  https://ark.cn-beijing.volces.com/api/coding  authStyle='bearer'（ADR-0012）
//   - 未来其他兼容供应商: 由 createLLM switch case 传入
//
// 鉴权 header 分叉（ADR-0012 §7）：
//   - 'x-api-key' → { 'x-api-key': apiKey }               （Anthropic 原生 API 标准）
//   - 'bearer'    → { 'Authorization': `Bearer ${apiKey}` }（ANTHROPIC_AUTH_TOKEN 方式）
//   两分支均恒发 'anthropic-version'（Claude Code 行为一致）
//
// 错误处理：沿用 ADR-0010 空内容 throw 纪律（fake green 防御）；authStyle 不新增错误边界
// ============================================================

type AnthropicAuthStyle = 'x-api-key' | 'bearer'

export class AnthropicCompatAdapter implements LLMAdapter {
  private apiKey: string
  private baseURL: string
  private model: string
  private authStyle: AnthropicAuthStyle

  constructor(opts: { apiKey: string; baseURL: string; model: string; authStyle?: AnthropicAuthStyle }) {
    this.apiKey = opts.apiKey
    this.baseURL = opts.baseURL
    this.model = opts.model
    this.authStyle = opts.authStyle ?? 'x-api-key'
  }

  /** 按 authStyle 构造鉴权 + 版本 header（ADR-0012 §7） */
  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
    }
    if (this.authStyle === 'bearer') {
      headers['Authorization'] = `Bearer ${this.apiKey}`
    } else {
      headers['x-api-key'] = this.apiKey
    }
    return headers
  }

  async generate(prompt: string, system?: string): Promise<string> {
    const res = await fetch(`${this.baseURL}/v1/messages`, {
      method: 'POST',
      headers: this.buildHeaders(),
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

    // 提取所有 type==='text' 块并拼接（ADR-0012 §10 live 发现）：
    // 推理模型（glm-5.2 等）content 首块常是 { type:'thinking' }，不能写死 content[0].text
    const text = Array.isArray(body?.content)
      ? body.content
          .filter((b: { type?: string }) => b?.type === 'text')
          .map((b: { text?: string }) => b.text ?? '')
          .join('')
      : undefined
    if (typeof text !== 'string' || text.length === 0) {
      throw new Error(`Anthropic 返回空内容: ${JSON.stringify(body).slice(0, 200)}`)
    }
    return text
  }
}
