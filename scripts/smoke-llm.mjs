// ============================================================
// LLM live smoke — 真实打一次当前 .env 配置的 provider（ADR-0011/0012 §10 live 待验）
// ============================================================
// 用法：pnpm exec tsx scripts/smoke-llm.mjs
// 读 .env → loadConfig → createLLM → generate 一句 → 打印结果（不打印 key）
// ============================================================

import 'dotenv/config'
import { loadConfig } from '../src/config/index.ts'
import { createLLM } from '../src/llm/index.ts'

const mask = (s) => (typeof s === 'string' && s.length > 6 ? s.slice(0, 4) + '****' : '(unset)')

const cfg = loadConfig()
console.log('[smoke-llm] provider =', cfg.llm.provider)
console.log('[smoke-llm] baseURL  =', cfg.llm.baseURL ?? '(默认)')
console.log('[smoke-llm] model    =', cfg.llm.model ?? '(默认)')
console.log('[smoke-llm] apiKey   =', mask(cfg.llm.apiKey))

const llm = createLLM(cfg)
const prompt = '用一句话（不超过20字）确认你在线，并说出你是哪个模型。'
console.log('\n[smoke-llm] → prompt:', prompt)

const t0 = Date.now()
try {
  const out = await llm.generate(prompt)
  console.log(`[smoke-llm] ✅ 成功（${Date.now() - t0}ms），返回：\n`, out)
} catch (e) {
  console.error(`[smoke-llm] ❌ 失败（${Date.now() - t0}ms）：`, e?.message ?? e)
  process.exit(1)
}
