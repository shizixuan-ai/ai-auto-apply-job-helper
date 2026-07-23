#!/usr/bin/env node
// ============================================================
// probe-deepseek-v4-reasoning.mjs — 测 V4-flash reasoning + max_tokens
// ============================================================
// 背景（2026-07-23）：
//   bapply search live 跑通 LLM 端（不再是 404）但 2/3 fail:
//     - 1 个: "Anthropic 返回空内容" (只有 thinking 块,没 text 块)
//     - 1 个: "LLM 返回非 JSON"
//   假设：max_tokens=1024 在 V4-flash 上不够，reasoning 占满 token
//   ADR-0012 §10 当时 glm-5.2 1024 够，V4-flash 是更强 reasoning
//
// 目的：3 个数据点
//   Q1: V4-flash max_tokens=1024 / 4096 / 8192 下，content 块结构分别是什么？
//   Q2: 简单 JSON 输出任务（模拟 scoreJob 的 prompt）V4-flash 返的格式？
//   Q3: 长 prompt（贴真实 JD）下 V4-flash 表现？
//
// 用法：
//   npx tsx scripts/probe-deepseek-v4-reasoning.mjs
// ============================================================

import 'dotenv/config'

const apiKey = process.env.LLM_API_KEY
if (!apiKey) {
  console.error('[probe] ❌ 需要 LLM_API_KEY 环境变量')
  process.exit(1)
}

const ENDPOINT = 'https://api.deepseek.com/anthropic'

async function callV4({ system, prompt, maxTokens }) {
  const r = await fetch(`${ENDPOINT}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'deepseek-v4-flash',
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: prompt }],
    }),
  })
  const body = await r.json()
  const content = body?.content ?? []
  return {
    status: r.status,
    stop_reason: body?.stop_reason,
    contentTypes: content.map((b) => b.type),
    textLen: content.filter((b) => b.type === 'text').reduce((s, b) => s + (b.text?.length ?? 0), 0),
    thinkingLen: content.filter((b) => b.type === 'thinking').reduce((s, b) => s + (b.thinking?.length ?? 0), 0),
    firstTextBlock: content.find((b) => b.type === 'text')?.text?.slice(0, 200),
    usage: body?.usage,
  }
}

console.log(`[probe] V4-flash reasoning + max_tokens 行为探测\n`)

console.log(`[probe] === Q1: max_tokens 对 content 块结构的影响 ===`)
console.log(`[probe] prompt: 'say hi in 5 words'\n`)
for (const mt of [256, 512, 1024, 2048, 4096, 8192]) {
  const r = await callV4({ prompt: 'say hi in 5 words', maxTokens: mt })
  console.log(`  max_tokens=${String(mt).padStart(5)}: stop=${r.stop_reason} | types=[${r.contentTypes.join(',')}] | text=${r.textLen}char thinking=${r.thinkingLen}char | usage=${JSON.stringify(r.usage)}`)
}

console.log(`\n[probe] === Q2: 模拟 scoreJob 返 JSON 任务（V4-flash 默认行为） ===`)
console.log(`[probe] prompt: '给我打个分 0-1, 严格按 JSON 返: {"score": 0.7, "reason": "..."}'\n`)
for (const mt of [1024, 4096, 8192]) {
  const r = await callV4({ prompt: '给我打个分 0-1, 严格按 JSON 返: {"score": 0.7, "reason": "..."}', maxTokens: mt })
  console.log(`  max_tokens=${String(mt).padStart(5)}: textLen=${r.textLen} thinkingLen=${r.thinkingLen} | firstText: ${r.firstTextBlock?.replace(/\n/g, ' ').slice(0, 120) ?? '(空)'}`)
}

console.log(`\n[probe] === Q3: 长 prompt 模拟真实 JD（贴 500 字符）===`)
const fakeJd = '岗位要求：'.padEnd(500, '精通 Java/Go/Python，3 年以上经验，本科及以上。')
const realPrompt = `JD: ${fakeJd}\n\n严格按 JSON 返: {"score": 0.8, "reason": "..."}`
for (const mt of [1024, 4096, 8192]) {
  const r = await callV4({ prompt: realPrompt, maxTokens: mt })
  console.log(`  max_tokens=${String(mt).padStart(5)}: textLen=${r.textLen} thinkingLen=${r.thinkingLen} | firstText: ${r.firstTextBlock?.replace(/\n/g, ' ').slice(0, 120) ?? '(空)'}`)
}

console.log(`\n[probe] === 结论对照 ===`)
console.log(`  若 max_tokens 提到 4096 就有 text 块 → 提 src 的 max_tokens 默认值`)
console.log(`  若 8192 都没 text → V4-flash 行为异常,降级 model (chat/reasoner)`)
console.log(`  若 Q2/Q3 返的不是纯 JSON(带 markdown fence) → 改 src JSON 解析要更宽容`)
