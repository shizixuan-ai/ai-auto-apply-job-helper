// ============================================================
// runSearchAndWrite — Sprint 1A GREEN
// ============================================================
// search → fetchDetail → scoreJob → 阈值过滤 → createRecord
//
// 核心设计：
//   - 所有副作用通过 deps 注入（便于单测）
//   - 单 job 失败不阻塞整体（计入 failed）
//   - 简历解析失败时整体直接返回 action: 'error'（无法打分）
// ============================================================

import type { ResumeSummary, ScoreResult, ScoreWeights } from '../../types/index.js'
import { scoreJob } from '../../scoring/index.js'
import { formatDimensionsForFeishu } from '../../scoring/persistence.js'
import { ResumeNotFoundError, IncompleteResumeError, ResumeParseError } from '../../resume/yaml-parser.js'

// ============================================================
// 类型定义
// ============================================================

/** BOSS 抓取的岗位原始格式（与 browser.SearchResult 对齐） */
export interface SearchResultLite {
  id: string
  title: string
  company: string
  salary: string
  city?: string
  experience?: string
  degree?: string
  labels?: string[]
  brandStage?: string
  brandIndustry?: string
  brandScale?: string
  welfare?: string[]
  skills?: string[]
  link?: string
  /** Sprint 2B：招聘方 HR 的 BOSS 加密 uid（friend/add 第二参数） */
  hrUid?: string
  /** Sprint 2026-07-12：card.json 必传参数（来自 search/joblist.json） */
  lid?: string
  /** Sprint 2026-07-12：card.json 必传参数（来自 search/joblist.json） */
  securityId?: string
}

/** handler 入参 */
export interface SearchWriteOptions {
  keyword: string
  city?: string
  write: boolean          // true = 真写飞书；false = 仅搜索 + 打分
  dryRun: boolean         // 走完整流程但不 createRecord
  noThreshold: boolean    // true = 不过滤（所有 scored 都算 passed）
  limit: number
}

/** 简历解析结果 */
export interface ResumeResolution {
  summary: ResumeSummary
  source: 'yaml'
  warnings: string[]
}

/** 飞书写入字段（中文字段名，与飞书表 init-feishu.sh 字段定义一致） */
export interface FeishuJobFields {
  职位: string
  公司: string
  BOSS_ID: string
  薪资?: string
  城市?: string
  分数: number
  匹配原因: string
  /** Sprint 1C：6 维评分详情（JSON 字符串，飞书长文本字段塞 JSON） */
  六维详情?: string
  JD摘要: string
  /** 飞书日期字段要毫秒时间戳（不是 ISO 字符串） */
  匹配时间: number
  /** Sprint 2B：HR 加密 uid（friend/add 第二参数 uid） */
  HR_UID?: string
  /** Sprint C (ADR-0008)：BOSS job lid（来自 joblist.json，friend/add URL query 参数） */
  LID?: string
  /** Sprint C (ADR-0008)：friend/add 鉴权密钥（明文存，飞书 Bitable 1.0 不支持字段加密） */
  SECURITY_ID?: string
}

/** 依赖注入（生产 vs 单测可换） */
export interface SearchWriteDeps {
  searchJobs: (keyword: string, city?: string) => Promise<SearchResultLite[]>
  /**
   * Sprint 2026-07-12：签名扩展为 (jobId, ctx)
   * ctx 来自 SearchResult 的 lid + securityId，让 fetchJobDetail 走 card.json wapi 路径
   * 老测试用 (jobId) 单参 — TypeScript 允许少传 optional 参数
   */
  fetchJobDetail: (jobId: string, ctx?: { lid?: string; securityId?: string }) => Promise<string>
  /**
   * Sprint 1C：scoreJob 返 ScoreResult（含 totalScore + totalReason + 6 维 dimensions）
   * weights 参数 optional — 不传时用 DEFAULT_WEIGHTS
   */
  scoreJob: (
    jd: string,
    summary: ResumeSummary,
    llm: unknown,
    weights?: ScoreWeights,
  ) => Promise<ScoreResult>
  createRecord: (fields: FeishuJobFields) => Promise<{ record_id: string }>
  resolveResume: () => Promise<ResumeResolution>
  /** LLM 实例（实际未在 handler 直接用，但 scoreJob deps 需要） */
  llm: unknown
  /** 评分阈值 */
  threshold: number
}

/**
 * Sprint E-3.2a (Step A)：通过阈值 + 写完飞书的 job 详情.
 * auto-handler.bossSearch 直接消费此数组喂给 sendGreeting (避免 auto 重新拼评分逻辑)
 *
 * dryRun 时 recordId = 'dry-run-noop' (与 cli/index.ts:289 dryRun noop 行为一致)
 */
export interface PassingJob {
  jobId: string
  lid?: string
  securityId?: string
  title: string
  recordId: string
  score: number
}

/** 任务结果 */
export type SearchWriteResult =
  | {
      action: 'ok'
      total: number
      scored: number
      passed: number
      written: number
      failed: number
      dryRun: boolean
      resumeSource: 'yaml'
      resumeWarnings: string[]
      /** Sprint E-3.2a：通过阈值 (≥ threshold || noThreshold) 的 job, 已写入飞书 */
      passingJobs: PassingJob[]
    }
  | {
      action: 'error'
      error: string
    }

// ============================================================
// 常量
// ============================================================

/** JD 写入飞书前的截断长度 */
const JD_SNIPPET_MAX = 200
/** reason 截断长度 */
const REASON_MAX = 200

// ============================================================
// 主流程
// ============================================================

export async function runSearchAndWrite(
  opts: SearchWriteOptions,
  deps: SearchWriteDeps,
): Promise<SearchWriteResult> {
  // 1) 解析简历（失败时整体返回 error，不进入打分）
  let resume: ResumeResolution
  try {
    resume = await deps.resolveResume()
  } catch (err) {
    if (
      err instanceof ResumeNotFoundError ||
      err instanceof IncompleteResumeError ||
      err instanceof ResumeParseError
    ) {
      return { action: 'error', error: err.message }
    }
    throw err
  }

  // 2) 搜索
  const allJobs = await deps.searchJobs(opts.keyword, opts.city)
  const jobs = allJobs.slice(0, opts.limit)

  let scored = 0
  let passed = 0
  let written = 0
  let failed = 0
  // Sprint E-3.2a (Step A)：收集通过阈值的 job 详情 (bossSearch 需返)
  const passingJobs: PassingJob[] = []

  // 3) 逐个处理
  for (const job of jobs) {
    try {
      const jd = await deps.fetchJobDetail(job.id, { lid: job.lid, securityId: job.securityId })
      const result = await deps.scoreJob(jd, resume.summary, deps.llm)
      scored++

      const meetsThreshold = opts.noThreshold || result.totalScore >= deps.threshold
      if (!meetsThreshold) continue

      passed++

      // Sprint E-3.2a: 即使 --no-write 模式也收集 passingJobs (bossSearch 可用)
      //  auto-handler 用 passingJobs 来决定 sendGreeting 目标
      // dryRun 时 createRecord 返 {record_id:'dry-run-noop'}, 写成 noop marker
      let recordId = 'dry-run-noop'
      if (opts.write) {
        const reason = `score=${result.totalScore.toFixed(2)}`
        const fields: FeishuJobFields = {
          职位: job.title,
          公司: job.company,
          BOSS_ID: job.id,
          薪资: job.salary ?? '',
          城市: job.city ?? '',
          分数: result.totalScore,
          匹配原因: reason.slice(0, REASON_MAX),
          // Sprint 1C：6 维详情塞 JSON 字符串进飞书长文本字段
          六维详情: formatDimensionsForFeishu(result),
          JD摘要: jd.slice(0, JD_SNIPPET_MAX),
          // 飞书日期字段要毫秒时间戳（不是 ISO 字符串）
          匹配时间: Date.now(),
        }
        // Sprint 2B：HR 加密 uid（sync-handler 后续读取用）
        // 仅在 truthy 时设置，避免飞书表出现 HR_UID: undefined
        if (job.hrUid) {
          fields.HR_UID = job.hrUid
        }
        // Sprint C (ADR-0008)：LID + SECURITY_ID 透传（解锁 auto-greet mode）
        //   - 仅在 truthy 时设置，避免飞书表出现 undefined
        //   - sync-handler 读取这 2 个字段后调 sendGreeting（friend/add URL query）
        //   - SECURITY_ID 是明文（飞书 Bitable 1.0 不支持字段加密，见 ADR-0008 §9 后续）
        if (job.lid) {
          fields.LID = job.lid
        }
        if (job.securityId) {
          fields.SECURITY_ID = job.securityId
        }
        const created = await deps.createRecord(fields)
        recordId = created.record_id
        written++
      }
      // Sprint E-3.2a：push 到 passingJobs (auto-handler 直接消费)
      passingJobs.push({
        jobId: job.id,
        lid: job.lid,
        securityId: job.securityId,
        title: job.title,
        recordId,
        score: result.totalScore,
      })
    } catch (err) {
      failed++
      // Sprint 1A 修复 P0：不能静默吞错（用户报"全部失败看不到原因"）
      // 1B 接入 pino 后替换为结构化日志
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[runSearchAndWrite] job=${job.id} (${job.title}) failed: ${msg}`)
    }
  }

  return {
    action: 'ok',
    total: jobs.length,
    scored,
    passed,
    written,
    failed,
    dryRun: !opts.write,
    resumeSource: resume.source,
    resumeWarnings: resume.warnings,
    passingJobs,  // Sprint E-3.2a：auto-handler.bossSearch 直接消费
  }
}
