import 'dotenv/config'
import type { AppConfig, LLMProvider, ScoreWeights } from '../types/index.js'
import { DEFAULT_WEIGHTS } from '../scoring/dimensions.js'

/** SCORE_THRESHOLD 默认值 */
const DEFAULT_SCORE_THRESHOLD = 0.85

/**
 * 从环境变量加载并验证配置。
 * 验证失败时抛出明确错误信息。
 */
export function loadConfig(): AppConfig {
  return {
    feishu: {
      appId: requireEnv('FEISHU_APP_ID'),
      appSecret: requireEnv('FEISHU_APP_SECRET'),
      // list/sync/stats 命令需要，缺时给空串由 handler 友好提示
      appToken: process.env.FEISHU_APP_TOKEN ?? '',
      tableId: process.env.FEISHU_TABLE_ID ?? '',
    },
    llm: parseLLMConfig(),
    boss: {
      resumeUid: process.env.BOSS_RESUME_UID,
    },
    browser: {
      chromiumPath: process.env.CHROMIUM_PATH,
    },
    scoreThreshold: parseScoreThreshold(),
    scoreWeights: parseScoreWeights(),
  }
}

/**
 * Sprint 1D Phase 1（ADR-0011 §2.4）：解析 LLM_* 4 env + 老 env hard fail 检测
 *
 * 行为：
 *   - LLM_PROVIDER unset → 'deepseek'（default）
 *   - 4 个 LLM_* env 透传给 config.llm（apiKey / baseURL / model）
 *   - 老 env 5 个 → 对应新 env 未设 → throw（一次性列全，不逐个报错）
 *
 * 老 env → 新 env 映射（ADR-0011 §2.3）：
 *   - DEEPSEEK_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY → LLM_API_KEY
 *   - OLLAMA_BASE_URL → LLM_BASE_URL
 *   - OLLAMA_MODEL → LLM_MODEL
 *
 * Phase 1 保留老 5 字段赋值（兼容老配置直到 Phase 2 cleanup，详见 ADR-0011 §9.5）
 */
function parseLLMConfig(): AppConfig['llm'] {
  // 老 env → 新 env 映射
  const OLD_TO_NEW: Record<string, string> = {
    DEEPSEEK_API_KEY: 'LLM_API_KEY',
    OPENAI_API_KEY: 'LLM_API_KEY',
    ANTHROPIC_API_KEY: 'LLM_API_KEY',
    OLLAMA_BASE_URL: 'LLM_BASE_URL',
    OLLAMA_MODEL: 'LLM_MODEL',
  }

  // 扫老 env：任一存在 + 对应新 env 未设 → 收集到 triggered
  const triggered: { old: string; new: string }[] = []
  for (const [oldKey, newKey] of Object.entries(OLD_TO_NEW)) {
    if (process.env[oldKey] && !process.env[newKey]) {
      triggered.push({ old: oldKey, new: newKey })
    }
  }

  if (triggered.length > 0) {
    const lines = triggered.map((t) => `  - ${t.old} → ${t.new}`)
    throw new Error(
      `[LLM config error] 检测到老 env 存在但对应新 env 未设，请迁移：\n` +
      lines.join('\n') +
      `\n迁移指南：docs/adr/0011-llm-multi-provider.md §2.4`,
    )
  }

  return {
    provider: (process.env.LLM_PROVIDER ?? 'deepseek') as LLMProvider,
    apiKey: process.env.LLM_API_KEY,
    baseURL: process.env.LLM_BASE_URL,
    model: process.env.LLM_MODEL,
  }
}

/**
 * 解析 SCORE_WEIGHTS 环境变量
 * - 未设 → DEFAULT_WEIGHTS
 * - 格式: SCORE_WEIGHTS=education:0.1,experience:0.3,skill:0.1,project:0.3,stability:0.1,potential:0.1
 * - 任意字段缺/非数字 → 抛错
 * - 总和 ≠ 1 → 抛错
 */
function parseScoreWeights(): ScoreWeights {
  const raw = process.env.SCORE_WEIGHTS
  if (!raw) return DEFAULT_WEIGHTS

  // 解析 key:value 对
  const pairs = raw.split(',').map((p) => p.trim()).filter(Boolean)
  const result: Partial<ScoreWeights> = {}

  for (const pair of pairs) {
    const [key, value] = pair.split(':').map((s) => s.trim())
    if (!key || !value) {
      throw new Error(`SCORE_WEIGHTS 格式错误：${pair}（应为 key:value）`)
    }
    const n = Number(value)
    if (!Number.isFinite(n)) {
      throw new Error(`SCORE_WEIGHTS.${key} 不是合法数字：${value}`)
    }
    if (n < 0 || n > 1) {
      throw new Error(`SCORE_WEIGHTS.${key} 越界（${n}，应在 0~1 之间）`)
    }
    ;(result as Record<string, number>)[key] = n
  }

  // 必须包含全部 6 个维度
  const requiredKeys = ['education', 'experience', 'skill', 'project', 'stability', 'potential'] as const
  for (const k of requiredKeys) {
    if (result[k] === undefined) {
      throw new Error(`SCORE_WEIGHTS 缺字段：${k}`)
    }
  }

  // 总和校验
  const weights = result as ScoreWeights
  const sum =
    weights.education + weights.experience + weights.skill +
    weights.project + weights.stability + weights.potential
  if (Math.abs(sum - 1) > 1e-9) {
    throw new Error(`SCORE_WEIGHTS 总和不归一化（=${sum}，应 = 1）`)
  }

  return weights
}

/**
 * 解析 SCORE_THRESHOLD 环境变量
 * - 未设 → 0.85
 * - 非数字 / 越界（<0 或 >1） → 抛错
 */
function parseScoreThreshold(): number {
  const raw = process.env.SCORE_THRESHOLD
  if (!raw) return DEFAULT_SCORE_THRESHOLD

  const n = Number(raw)
  if (!Number.isFinite(n)) {
    throw new Error(`SCORE_THRESHOLD 不是合法数字：${raw}`)
  }
  if (n < 0 || n > 1) {
    throw new Error(`SCORE_THRESHOLD 越界（${n}，应在 0~1 之间）`)
  }
  return n
}

function requireEnv(key: string): string {
  const value = process.env[key]
  if (!value) {
    throw new Error(
      `缺少必要环境变量: ${key}\n` +
      `请创建 .env 文件并填充对应值，参考 .env.example`,
    )
  }
  return value
}
