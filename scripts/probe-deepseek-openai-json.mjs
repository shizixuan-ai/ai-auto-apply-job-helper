#!/usr/bin/env node
// ============================================================
// probe-deepseek-openai-json.mjs — 验证 OpenAI 模式 + response_format
// ============================================================
// 背景（2026-07-23）：
//   用户指令:"如果 anthropic 模式不好用,我们就切换 openai 模式"
//   文档查证：response_format: json_object 是 OpenAI 协议专属
//   deepseek-chat 2026-07-24 23:59 弃用,只剩 v4-flash
//
// 目的：3 个数据点（为切 OpenAI 模式提供决策依据）
//   Q1: OpenAI 模式端点 https://api.deepseek.com/v1/chat/completions 可用？
//   Q2: response_format: json_object 真能强制纯 JSON?
//   Q3: v4-flash 走 OpenAI 模式时,是否还出 thinking / 推理行为？
//        （OpenAI SDK 协议下 V4-flash 行为可能与 Anthropic 模式不同）
//
// 用法：
//   npx tsx scripts/probe-deepseek-openai-json.mjs
// ============================================================

import 'dotenv/config'

const apiKey = process.env.LLM_API_KEY
if (!apiKey) {
  console.error('[probe] ❌ 需要 LLM_API_KEY 环境变量')
  process.exit(1)
}

const ENDPOINT = 'https://api.deepseek.com/v1/chat/completions'

async function callOpenAI({ model, messages, responseFormat, maxTokens = 2048 }) {
  const body = {
    model,
    messages,
    max_tokens: maxTokens,
    temperature: 0.7,
  }
  if (responseFormat) {
    body.response_format = responseFormat
  }
  const r = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  })
  const json = await r.json()
  const choice = json?.choices?.[0]
  return {
    status: r.status,
    finishReason: choice?.finish_reason,
    content: choice?.message?.content,
    reasoningContent: choice?.message?.reasoning_content,  // OpenAI 模式下 DeepSeek 的 reasoning 字段
    contentLength: choice?.message?.content?.length ?? 0,
    usage: json?.usage,
  }
}

console.log(`[probe] OpenAI 模式 + JSON mode 验证\n`)
console.log(`[probe] endpoint: ${ENDPOINT}\n`)

const scoreJobLikePrompt = `你是求职匹配度评估专家。JD: 滴滴向量数据库,要求 C++/Go/Java。简历: 5 年 Java 后端。\n\n严格按 JSON 返: {"totalScore": 0.7, "totalReason": "..."}`

console.log(`[probe] === Q1: OpenAI 模式 + v4-flash 基础连通性 ===`)
const q1 = await callOpenAI({
  model: 'deepseek-v4-flash',
  messages: [{ role: 'user', content: 'say hi in 5 words' }],
  maxTokens: 100,
})
console.log(`  status=${q1.status} finish=${q1.finishReason} content=${q1.content?.slice(0, 80)}`)
console.log(`  reasoningContent=${q1.reasoningContent?.slice(0, 80) ?? '(无)'}\n`)

console.log(`[probe] === Q2: response_format=json_object 真强制 JSON 吗 ===`)
const q2a = await callOpenAI({
  model: 'deepseek-v4-flash',
  messages: [
    { role: 'system', content: '你返 JSON 格式' },
    { role: 'user', content: scoreJobLikePrompt },
  ],
  responseFormat: { type: 'json_object' },
  maxTokens: 2048,
})
const q2aIsJson = q2a.content && (q2a.content.startsWith('{') || q2a.content.startsWith('['))
console.log(`  [json_object] status=${q2a.status} finish=${q2a.finishReason} contentLen=${q2a.contentLength} isJson=${q2aIsJson}`)
console.log(`  preview: ${q2a.content?.slice(0, 200) ?? '(空)'}`)
console.log(`  reasoningContent: ${q2a.reasoningContent?.slice(0, 100) ?? '(无)'}\n`)

console.log(`[probe] === Q3: 不带 response_format,v4-flash 行为 ===`)
const q3 = await callOpenAI({
  model: 'deepseek-v4-flash',
  messages: [{ role: 'user', content: scoreJobLikePrompt }],
  maxTokens: 2048,
})
console.log(`  [无 json_object] status=${q3.status} finish=${q3.finishReason} contentLen=${q3.contentLength}`)
console.log(`  preview: ${q3.content?.slice(0, 200) ?? '(空)'}`)
console.log(`  reasoningContent: ${q3.reasoningContent?.slice(0, 100) ?? '(无)'}\n`)

console.log(`[probe] === Q4: model=deepseek-chat（24h 内仍可用,测 JSON 模式） ===`)
const q4 = await callOpenAI({
  model: 'deepseek-chat',
  messages: [
    { role: 'system', content: '你返 JSON' },
    { role: 'user', content: scoreJobLikePrompt },
  ],
  responseFormat: { type: 'json_object' },
  maxTokens: 2048,
})
const q4IsJson = q4.content && (q4.content.startsWith('{') || q4.content.startsWith('['))
console.log(`  [chat + json_object] status=${q4.status} finish=${q4.finishReason} contentLen=${q4.contentLength} isJson=${q4IsJson}`)
console.log(`  preview: ${q4.content?.slice(0, 200) ?? '(空)'}`)
console.log(`  reasoningContent: ${q4.reasoningContent?.slice(0, 100) ?? '(无)'}\n`)

console.log(`[probe] === 决策对照表 ===`)
console.log(`  Q1=200 + Q2 纯 JSON(无 fence) + Q3 有 reasoning_content → OpenAI 模式可用,json_object 强制 JSON,迁移 src`)
console.log(`  Q1=200 + Q2 带 markdown fence → OpenAIAdapter 加 JSON 解析时 strip fence`)
console.log(`  Q1=404 / 401 → DeepSeek /v1 端点对你账号不可用,继续走 Anthropic 但 max_tokens 提 4096 + prompt 改`)
console.log(`  Q4 失败但 Q2 成功 → 用 v4-flash 不用 chat(chat 24h 后弃用)`)
