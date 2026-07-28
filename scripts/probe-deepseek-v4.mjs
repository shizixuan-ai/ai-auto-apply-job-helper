#!/usr/bin/env node
// ============================================================
// probe-deepseek-v4.mjs — 验证 DeepSeek V4 + Anthropic 端点
// ============================================================
// 背景（2026-07-23）：
//   用户的 .env: LLM_PROVIDER=deepseek / LLM_BASE_URL=https://api.deepseek.com/anthropic
//   / LLM_MODEL=deepseek-v4-flash
//   live bapply search 5/5 报 "404 status code (no body)"
//   根因（已确认）：OpenAIAdapter 写死绑 deepseek，发 OpenAI 格式到 /anthropic 端点 → 404
//   截图显示：DeepSeek-V4 是"预览版本"，V4 走 /anthropic 端点（Anthropic 协议）
//
// 目的：用真实 curl 回答 3 个问题（为 src 改造提供依据）：
//   Q1: DeepSeek /anthropic 端点的正确鉴权 header 是什么？Bearer 还是 x-api-key？
//   Q2: 哪些 model 名在 /anthropic 端点真存在？deepseek-v4-flash / deepseek-chat / deepseek-reasoner
//   Q3: /anthropic 端点路径是否就是 /v1/messages？（Anthropic 标准）
//
// 用法：
//   export LLM_API_KEY=sk-xxx   ← 必须
//   npx tsx scripts/probe-deepseek-v4.mjs
// ============================================================

import 'dotenv/config'

const apiKey = process.env.LLM_API_KEY
if (!apiKey) {
  console.error('[probe] ❌ 需要 LLM_API_KEY 环境变量')
  console.error('[probe]   export LLM_API_KEY=sk-xxx')
  process.exit(1)
}

const ENDPOINT = 'https://api.deepseek.com/anthropic'
const MODELS_TO_TRY = ['deepseek-v4-flash', 'deepseek-chat', 'deepseek-reasoner', 'deepseek-coder']

console.log(`[probe] DeepSeek /anthropic 端点验证`)
console.log(`[probe] endpoint: ${ENDPOINT}`)
console.log(`[probe] apiKey: ${apiKey.slice(0, 8)}...${apiKey.slice(-4)}`)
console.log(`[probe] 待试 model: ${MODELS_TO_TRY.join(', ')}\n`)

/** 用指定鉴权方式调一次 messages,记录真实 status + body 前 200 字符 */
async function tryRequest(authStyle, model) {
  const headers = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
  }
  if (authStyle === 'bearer') {
    headers['Authorization'] = `Bearer ${apiKey}`
  } else if (authStyle === 'x-api-key') {
    headers['x-api-key'] = apiKey
  }

  const url = `${ENDPOINT}/v1/messages`
  const body = JSON.stringify({
    model,
    max_tokens: 30,
    messages: [{ role: 'user', content: 'say hi in 5 words' }],
  })

  try {
    const resp = await fetch(url, { method: 'POST', headers, body })
    const text = await resp.text()
    return {
      authStyle,
      model,
      status: resp.status,
      bodyPreview: text.slice(0, 250),
    }
  } catch (err) {
    return { authStyle, model, status: 0, bodyPreview: `THROW: ${err.message}` }
  }
}

console.log(`[probe] === 测试 1: Bearer 鉴权（参考 ADR-0012 minimax/huoshan 模式） ===`)
for (const m of MODELS_TO_TRY) {
  const r = await tryRequest('bearer', m)
  console.log(`  [bearer / ${m.padEnd(20)}] HTTP ${r.status} | ${r.bodyPreview.replace(/\n/g, ' ').slice(0, 200)}`)
}

console.log(`\n[probe] === 测试 2: x-api-key 鉴权（Anthropic 原生标准） ===`)
for (const m of MODELS_TO_TRY) {
  const r = await tryRequest('x-api-key', m)
  console.log(`  [x-api-key / ${m.padEnd(20)}] HTTP ${r.status} | ${r.bodyPreview.replace(/\n/g, ' ').slice(0, 200)}`)
}

console.log(`\n[probe] === 测试 3: 路径探测（确认是 /v1/messages 还是其他） ===`)
// 试探根路径 /anthropic（不带 /v1/messages）
try {
  const rootResp = await fetch(ENDPOINT, { method: 'GET' })
  const rootText = await rootResp.text()
  console.log(`  GET ${ENDPOINT}            → HTTP ${rootResp.status} | ${rootText.slice(0, 150)}`)
} catch (err) {
  console.log(`  GET ${ENDPOINT}            → THROW: ${err.message}`)
}

console.log(`\n[probe] === 探针结论对照表（用于设计 env schema） ===`)
console.log(`  若 bearer / deepseek-v4-flash = 200 → env 改 LLM_PROVIDER=anthropic-compat, LLM_AUTH_STYLE=bearer`)
console.log(`  若 x-api-key / deepseek-v4-flash = 200 → env 改 LLM_PROVIDER=anthropic-compat, LLM_AUTH_STYLE=x-api-key`)
console.log(`  若 deepseek-chat 在 /anthropic = 200 → V4 还没开放,降级 chat`)
console.log(`  若全 404 → /anthropic 端点对你账号不可用,降级回 /v1 端点 + OpenAI 协议`)
