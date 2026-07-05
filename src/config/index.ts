import 'dotenv/config'
import type { AppConfig, LLMProvider } from '../types/index.js'

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
  }
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
