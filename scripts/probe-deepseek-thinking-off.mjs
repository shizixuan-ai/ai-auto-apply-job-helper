#!/usr/bin/env node
// ============================================================
// probe-deepseek-thinking-off.mjs — 验证 thinking: disabled 有效
// ============================================================
// 背景（2026-07-23）：
//   user 提示:thinking 模式可关闭(参考 docs/guides/thinking_mode)
//   Anthropic 协议下不能完全关,OpenAI 协议下用 extra_body 传
//   user 提示:max_tokens 可调到 200k
//
// 目的：3 个数据点
//   Q1: 加 "thinking": {"type": "disabled"} 后,v4-flash 还出 reasoning_content 吗?
//   Q2: 关 thinking 后 + json_object,响应是不是真纯 JSON(无 fence)?
//   Q3: 关 thinking 后 max_tokens=1024 够用吗?(scoring 6 维 JSON 只 ~200 token)
//
// 用法：
//   npx tsx scripts/probe-deepseek-thinking-off.mjs
// ============================================================

import 'dotenv/config'

const apiKey = process.env.LLM_API_KEY
if (!apiKey) {
  console.error('[probe] ❌ 需要 LLM_API_KEY')
  process.exit(1)
}

const ENDPOINT = 'https://api.deepseek.com/v1/chat/completions'

async function call({ body }) {
  const r = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  })
  return { status: r.status, body: await r.json() }
}

const scoreJobLikePrompt = `你是求职匹配度评估专家。JD: 滴滴向量数据库,要求 C++/Go/Java。简历: 5 年 Java 后端。\n\n严格按 JSON 返: {"totalScore": 0.7, "totalReason": "..."}`

console.log(`[probe] === Q1: 关 thinking 后,v4-flash 行为 ===\n`)
const q1 = await call({
  body: {
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: scoreJobLikePrompt }],
    thinking: { type: 'disabled' },
    max_tokens: 1024,
  },
})
const q1Choice = q1.body?.choices?.[0]
console.log(`  status=${q1.status} finish=${q1Choice?.finish_reason}`)
console.log(`  reasoning_content: ${q1Choice?.message?.reasoning_content === null || q1Choice?.message?.reasoning_content === undefined ? '(无 ✓)' : q1Choice.message.reasoning_content.slice(0, 100)}`)
console.log(`  contentLen=${q1Choice?.message?.content?.length ?? 0}`)
console.log(`  content preview: ${q1Choice?.message?.content?.slice(0, 200) ?? '(空)'}\n`)

console.log(`[probe] === Q2: 关 thinking + json_object + max_tokens=1024 ===\n`)
const q2 = await call({
  body: {
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: scoreJobLikePrompt }],
    thinking: { type: 'disabled' },
    response_format: { type: 'json_object' },
    max_tokens: 1024,
  },
})
const q2Choice = q2.body?.choices?.[0]
const q2Content = q2Choice?.message?.content ?? ''
const q2IsJson = q2Content.startsWith('{') && q2Content.endsWith('}')
console.log(`  status=${q2.status} finish=${q2Choice?.finish_reason}`)
console.log(`  reasoning_content: ${q2Choice?.message?.reasoning_content === null || q2Choice?.message?.reasoning_content === undefined ? '(无 ✓)' : q2Choice.message.reasoning_content.slice(0, 100)}`)
console.log(`  isJson=${q2IsJson} contentLen=${q2Content.length}`)
console.log(`  content preview: ${q2Content.slice(0, 200)}\n`)

console.log(`[probe] === Q3: 真实长 JD(800字符) + 6 维评分完整 prompt + 关 thinking + json_object ===\n`)
const fakeJd = '岗位要求：'.padEnd(800, '精通 Java/Go/Python，3 年以上向量数据库/搜索经验，本科及以上，有大厂背景优先。')
const realPrompt = `你是求职匹配度评估专家。请根据【岗位描述】和【候选人简历】，从 6 个维度分别评估（每个维度 0~1 之间的分数），然后给出 1 个加权总分（0~1）和 1 句话总结。

【岗位描述】（已截断）
${fakeJd}

【候选人简历】
- 姓名: 测试
- 工作年限: 5
- 学历: 本科
- 技能: Java, Go, MySQL, Redis
- 近期项目: 电商后端 / 推荐系统

【输出要求】
仅返回严格 JSON（不要 markdown 代码块、不要任何解释文字），字段名严格一致：
{
  "education":   { "score": 0.85, "reason": "一句话理由" },
  "experience":  { "score": 0.90, "reason": "一句话理由" },
  "skill":       { "score": 0.75, "reason": "一句话理由" },
  "project":     { "score": 0.80, "reason": "一句话理由" },
  "stability":   { "score": 0.70, "reason": "一句话理由" },
  "potential":   { "score": 0.80, "reason": "一句话理由" },
  "totalScore":  0.82,
  "totalReason": "一句话总结匹配或不匹配的关键原因"
}`

const q3 = await call({
  body: {
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: realPrompt }],
    thinking: { type: 'disabled' },
    response_format: { type: 'json_object' },
    max_tokens: 1024,
  },
})
const q3Choice = q3.body?.choices?.[0]
const q3Content = q3Choice?.message?.content ?? ''
let q3Parsed = null
let q3ParseErr = null
try { q3Parsed = JSON.parse(q3Content) } catch (e) { q3ParseErr = e.message }
console.log(`  status=${q3.status} finish=${q3Choice?.finish_reason} contentLen=${q3Content.length}`)
console.log(`  JSON.parse ok=${!!q3Parsed} ${q3ParseErr ? 'err=' + q3ParseErr : ''}`)
console.log(`  top-level fields: ${q3Parsed ? Object.keys(q3Parsed).join(',') : '(parse failed)'}`)
if (q3Parsed?.totalScore !== undefined) console.log(`  totalScore: ${q3Parsed.totalScore}`)
console.log(`  reasoning_content: ${q3Choice?.message?.reasoning_content === null || q3Choice?.message?.reasoning_content === undefined ? '(无 ✓)' : q3Choice.message.reasoning_content.slice(0, 80)}\n`)

console.log(`[probe] === 决策对照 ===`)
console.log(`  Q1 reasoning=(无) + Q2 纯 JSON + Q3 JSON.parse ok + 6 维完整 → 完美!改 src:`)
console.log(`    OpenAIAdapter 加 thinking:disabled + response_format:json_object,max_tokens 1024`)
console.log(`    .env: LLM_ADAPTER=openai / LLM_BASE_URL=https://api.deepseek.com/v1 / LLM_MODEL=deepseek-v4-flash`)
console.log(`  Q1 仍有 reasoning_content → thinking:disabled 没生效,改用 deepseek-chat 或换 strategy`)
console.log(`  Q3 JSON.parse 失败 → json_object 没生效,需要加 strip fence 逻辑`)
