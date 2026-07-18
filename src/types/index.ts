// ============================================================
// 核心类型定义
// ============================================================

/** LLM 供应商标识 */
export type LLMProvider = 'deepseek' | 'openai' | 'anthropic' | 'ollama'

/** 投递状态 */
export type ApplyStatus = 'pending' | 'greeted' | 'replied' | 'interviewing' | 'rejected' | 'closed'

/**
 * 打招呼状态枚举（Sprint 2A 引入）
 *
 * 与飞书表"打招呼状态"单选字段严格对齐（中文标签映射在 handler/feishu 层做）：
 *   - pending:          待发送（search-and-write 写入时的初态）
 *   - sent:             已发送（BOSS friend/add code=0）
 *   - failed:           业务失败（message 过长 / BOSS 其他 code / 网络错误）
 *   - rate_limited:     触发限额（BOSS chatRemindDialog.content 含"120 位 BOSS"，master 限流语义）
 *   - security_blocked: 风控拦截（预留，探针 P3 未实测触发）
 *   - session_expired:  BOSS code=1011 "当前登录状态已失效"（探针 P1/P2/P3 实测）
 *
 * 注意：枚举值是英文（代码可读），写飞书时翻译成中文标签。
 */
export type GreetStatus =
  | 'pending'
  | 'sent'
  | 'failed'
  | 'rate_limited'
  | 'security_blocked'
  /** Sprint 2026-07-14 新增：探针 P1/P2/P3 实测 bossCode=1011 */
  | 'session_expired'

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
  /** 招聘方 HR 的 BOSS 加密 uid（Sprint 2A：sendGreeting friend/add 需要） */
  hrUid?: string
  /**
   * BOSS list-context lid（card.json 必传参数，Sprint 2026-07-12 实测确认）
   *
   * 来源：search/joblist.json 响应里 jobList[].lid
   * 单 jobId 不够——必须 lid + securityId 才能拿到完整 JD
   *
   * Sprint 2026-07-15：补到 Job interface（之前 SearchResult 有，Job 缺，CLI 输出 / sync 路径用不到）
   */
  lid?: string
  /**
   * BOSS job securityId（card.json 必传参数，Sprint 2026-07-12 实测确认）
   *
   * 来源：search/joblist.json 响应里 jobList[].securityId
   * 完整 200+ 字符，send CLI 真发时必传（否则 friend/add bossCode=1011）
   *
   * Sprint 2026-07-15：补到 Job interface（同上 gap）
   */
  securityId?: string
  /** 打招呼状态（Sprint 2A：handler 写回飞书） */
  greetStatus?: GreetStatus
  /** 打招呼时间（毫秒时间戳，飞书日期字段 type=5） */
  greetedAt?: number
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
