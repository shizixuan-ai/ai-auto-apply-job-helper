// ============================================================
// 核心类型定义
// ============================================================

/** LLM 供应商标识 */
/**
 * Sprint 1D Phase 2（ADR-0011 §2.1）：string 化（替原 union），未来加供应商 0 改 types。
 * 已知值见下方 LLM_PROVIDER_VALUES 常量（提供 IDE 提示 + 编译期拼写检查）。
 * 运行时校验：createLLM switch default 抛 "不支持的 LLM 供应商"。
 */
export type LLMProvider = string

/**
 * Sprint 1D Phase 2（ADR-0011 §2.1）：已知 LLM 供应商常量
 * - deepseek:  OpenAI 协议，默认 https://api.deepseek.com/v1，模型 deepseek-chat
 * - openai:    OpenAI 协议，默认 https://api.openai.com/v1，模型 gpt-4o
 * - anthropic: Anthropic 协议，默认 https://api.anthropic.com，模型 claude-sonnet-4-20250514
 * - ollama:    OpenAI 协议（本地），默认 http://localhost:11434/v1，模型 llama3
 * - minimax:   Anthropic 协议，端点 https://api.minimaxi.com/anthropic（ADR §1 H1），模型 MiniMax-M2.7-highspeed，鉴权 Bearer（ADR-0012）
 * - huoshan:   Anthropic 协议（火山方舟 coding plan），端点 https://ark.cn-beijing.volces.com/api/coding，模型 glm-5.2，鉴权 Bearer（ADR-0012）
 * - anthropic-compat: 通用 Anthropic 协议供应商（ADR-0013），所有字段从 env 读，无默认
 *                    必须设 LLM_BASE_URL / LLM_MODEL / LLM_API_KEY;LLM_AUTH_STYLE 可选(默认 bearer)
 *                    适配场景: deepseek v4 / 智谱 GLM API / 通义千问 Anthropic 兼容 / 任何 /v1/messages 端点
 *
 * 用法：
 *   const provider: LLMProvider = LLM_PROVIDER_VALUES.MINIMAX  // IDE 拼写检查
 */
export const LLM_PROVIDER_VALUES = {
  DEEPSEEK: 'deepseek',
  OPENAI: 'openai',
  ANTHROPIC: 'anthropic',
  OLLAMA: 'ollama',
  MINIMAX: 'minimax',
  HUOSHAN: 'huoshan',
  ANTHROPIC_COMPAT: 'anthropic-compat',
} as const

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

/**
 * 简历摘要（Sprint 1B 扩展到 15 字段，原 5 字段 → 新 15 字段）
 *
 * - Sprint 1A：name, yearsOfExperience, education, skills, recentProjects
 * - Sprint 1B 强切：移除 education（拆分为 school + degree）
 *   + 新增 9 字段：gender, age, phone, email, targetRole, school, degree, major, isElite, isBigTech, workSummary
 * - 所有字段 optional：parser 强校验，类型上 defensive
 * - isElite / isBigTech 必填 boolean（候选人手填，不代码推）
 *
 * 字段来源：src/resume/yaml-parser.ts
 */
export interface ResumeSummary {
  // 基础信息
  name?: string
  gender?: '男' | '女' | '未知'
  age?: number
  phone?: string
  email?: string

  // 求职意向
  targetRole?: string

  // 教育背景（Sprint 1B 拆 education → school + degree）
  school?: string
  degree?: '本科' | '硕士' | '博士' | '其他'
  major?: string

  // 推断字段（Sprint 1B 手填，候选人最清楚自己）
  isElite?: boolean

  // 工作经历
  yearsOfExperience?: number
  isBigTech?: boolean
  /** array of "{公司} - {时间段} - {职位} - {描述}"（yaml-parser 拍平后形态） */
  recentProjects?: string[]

  // 技能
  skills?: string[]

  // 自我介绍（YAML `|` 块，parser 已 trim）
  workSummary?: string
}

// ============================================================
// Sprint 1C：6 维评分相关类型
// ============================================================

/**
 * 单维度评分（Sprint 1C 6 维加权评分）
 * - score: 0-1 之间的小数
 * - reason: 评分理由（LLM 生成，可能为空字符串）
 */
export interface ScoreDimension {
  score: number
  reason: string
}

/**
 * 6 维评分（Sprint 1C）
 * 维度顺序按权重从高到低排列（仅美学，逻辑无关）
 */
export interface ScoreDimensions {
  /** 学历匹配：学校层次 + 专业相关性 + 是否 985/211 */
  education: ScoreDimension
  /** 经验相关：工作年限 + 行业相关性 + 职位层级 */
  experience: ScoreDimension
  /** 技能契合：JD 要求技能 vs 候选人技能的覆盖度 */
  skill: ScoreDimension
  /** 项目深度：近期项目的复杂度、规模、影响力 */
  project: ScoreDimension
  /** 稳定性：跳槽频率 + 在职时长 */
  stability: ScoreDimension
  /** 综合潜力：成长性 + 学习能力 + 管理潜力 */
  potential: ScoreDimension
}

/**
 * 6 维权重（Sprint 1C）
 * 权重总和必须 = 1（computeWeightedTotal 会校验）
 */
export interface ScoreWeights {
  education: number
  experience: number
  skill: number
  project: number
  stability: number
  potential: number
}

/**
 * 评分结果（Sprint 1C 扩 6 维）
 * - totalScore: 加权总分 0-1（本地重算，不信 LLM 算术）
 * - totalReason: 总体匹配原因
 * - dimensions: 6 维详情
 */
export interface ScoreResult {
  totalScore: number
  totalReason: string
  dimensions: ScoreDimensions
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
    /**
     * Sprint 2026-07-23 / 404-retry-5 轮教训：
     * 协议（adapter）与供应商（provider）解耦 —— 同一供应商可能同时提供 OpenAI 协议端点
     * 和 Anthropic 协议端点（如 DeepSeek /v1 vs /anthropic）。让用户显式选，不再写死绑。
     * - 适用场景：用户在 .env 设 LLM_BASE_URL 指 /anthropic 端点但 LLM_PROVIDER=deepseek 时
     *   旧实现会发 OpenAI 格式到 Anthropic 端点 → 404
     * - 合法值: 'anthropic' | 'openai'
     * - unset → 'anthropic'（默认，2026-07-23 决策）
     * - 显式设了 → 完全覆盖 provider 推断的旧行为
     */
    adapter?: 'anthropic' | 'openai'
    /**
     * Sprint 1D Phase 2（ADR-0011 §2.3）：通用 3 字段
     * - apiKey:   通用 API key（来源 env LLM_API_KEY）
     * - baseURL:  通用 base URL（来源 env LLM_BASE_URL，可选 — provider 自带默认）
     * - model:    通用模型名（来源 env LLM_MODEL，可选 — provider 自带默认）
     */
    apiKey?: string
    baseURL?: string
    model?: string
    /**
     * Anthropic 协议鉴权 header 风格（ADR-0013）
     * - 适用场景：adapter='anthropic' 时（不论 provider 是什么）
     * - 合法值: 'x-api-key' | 'bearer'
     * - unset → 'bearer'（默认，适配多数国产 Anthropic 兼容）
     */
    authStyle?: 'x-api-key' | 'bearer'
  }
  boss: {
    /**
     * BOSS 直聘在线简历 UID（来源 env BOSS_RESUME_UID）
     * @deprecated 2026-07-21：当前 src/ 无任何消费点（grep 0 hit），是死配置。
     *                      保留解析仅为不破坏现存 .env；
     *                      下次 sprint 确认无新使用场景后可直接删 types 字段 + config 解析 + docs 表格。
     *                      用户侧建议：.env 删 `BOSS_RESUME_UID=...` 行。
     */
    resumeUid?: string
  }
  browser: {
    chromiumPath?: string
  }
  /** 评分阈值（search --write 命令使用，0~1） */
  scoreThreshold: number
  /** 6 维权重（Sprint 1C，从 SCORE_WEIGHTS env 解析或用默认）*/
  scoreWeights: ScoreWeights
}
