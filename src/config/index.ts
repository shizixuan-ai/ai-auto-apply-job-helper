import 'dotenv/config'
import type { AppConfig, LLMProvider } from '../types/index.js'

/** SCORE_THRESHOLD 默认值 */
const DEFAULT_SCORE_THRESHOLD = 0.85

/**
 * 从环境变量加载并验证配置。
 * 验证失败时抛出明确错误信息。
 */
export function loadConfig(): AppConfig {
  const provider = (process.env.LLM_PROVIDER ?? 'deepseek') as LLMProvider

  return {
    feishu: {
      appId: requireEnv('FEISHU_APP_ID'),
      appSecret: requireEnv('FEISHU_APP_SECRET'),
      // list/sync/stats 命令需要，缺时给空串由 handler 友好提示
      appToken: process.env.FEISHU_APP_TOKEN ?? '',
      tableId: process.env.FEISHU_TABLE_ID ?? '',
    },
    llm: {
      provider,
      deepseekApiKey: process.env.DEEPSEEK_API_KEY,
      openaiApiKey: process.env.OPENAI_API_KEY,
      anthropicApiKey: process.env.ANTHROPIC_API_KEY,
      ollamaBaseUrl: process.env.OLLAMA_BASE_URL,
      ollamaModel: process.env.OLLAMA_MODEL,
    },
    boss: {
      resumeUid: process.env.BOSS_RESUME_UID,
    },
    browser: {
      chromiumPath: process.env.CHROMIUM_PATH,
    },
    scoreThreshold: parseScoreThreshold(),
  }
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
