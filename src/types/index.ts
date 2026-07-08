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
  // BOSS 扩展字段（可选，老 Job fixture 不带也不报错）
  city?: string
  experience?: string
  degree?: string
  /** 原始 BOSS encryptedId（同 id，但语义清晰） */
  bossId?: string
  /** 招聘方 HR 名字 */
  hrName?: string
  /** 招聘方 HR 在线状态 */
  hrOnline?: boolean
  /** 公司融资阶段 */
  brandStage?: string
  /** 公司行业 */
  brandIndustry?: string
  /** 公司规模 */
  brandScale?: string
  /** 技能标签 */
  skills?: string[]
  /** 福利标签 */
  welfare?: string[]
  /** 原始链接 */
  link?: string
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

/** 简历摘要（Sprint 1A 引入，供 scoring/greet 共用） */
export interface ResumeSummary {
  name?: string
  yearsOfExperience?: number
  education?: string
  skills?: string[]
  recentProjects?: string[]
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
  /** 评分阈值（search --write 命令使用，0~1） */
  scoreThreshold: number
}
