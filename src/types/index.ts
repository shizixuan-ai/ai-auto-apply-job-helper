// ============================================================
// 核心类型定义
// ============================================================

/** LLM 供应商标识 */
export type LLMProvider = 'deepseek' | 'openai' | 'anthropic' | 'ollama'

/** 投递状态 */
export type ApplyStatus = 'pending' | 'greeted' | 'replied' | 'interviewing' | 'rejected' | 'closed'

/** 岗位信息 */
export interface Job {
  id: string
  title: string
  company: string
  salary: string
  jd: string
  url: string
  status: ApplyStatus
  createdAt: string
  updatedAt: string
}

/** 话术记录 */
export interface Greeting {
  id: string
  jobId: string
  content: string
  locked: boolean
  createdAt: string
  updatedAt: string
}

/** 飞书记录行（多维表格原始格式） */
export interface FeishuRecord {
  record_id: string
  fields: Record<string, unknown>
}

/** 应用配置 */
export interface AppConfig {
  feishu: {
    appId: string
    appSecret: string
    /** 多维表格 appToken（list/sync/stats 命令需要） */
    appToken?: string
    /** 多维表格 tableId（list/sync/stats 命令需要） */
    tableId?: string
  }
  llm: {
    provider: LLMProvider
    deepseekApiKey?: string
    openaiApiKey?: string
    anthropicApiKey?: string
    ollamaBaseUrl?: string
    ollamaModel?: string
  }
  boss: {
    resumeUid?: string
  }
  browser: {
    chromiumPath?: string
  }
}
