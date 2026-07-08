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

import type { ResumeSummary } from '../../types/index.js'
import { scoreJob } from '../../scoring/index.js'
import { ResumeNotFoundError, IncompleteResumeError } from '../../resume/md-fallback.js'

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
  source: 'md'
  warnings: string[]
}

/** 飞书写入字段（核心字段） */
export interface FeishuJobFields {
  BOSS_ID: string
  title: string
  company: string
  salary?: string
  city?: string
  score: number
  reason: string
  jd_snippet: string
  matchedAt: string
}

/** 依赖注入（生产 vs 单测可换） */
export interface SearchWriteDeps {
  searchJobs: (keyword: string, city?: string) => Promise<SearchResultLite[]>
  fetchJobDetail: (jobId: string) => Promise<string>
  scoreJob: (jd: string, summary: ResumeSummary, llm: unknown) => Promise<number>
  createRecord: (fields: FeishuJobFields) => Promise<{ record_id: string }>
  resolveResume: () => Promise<ResumeResolution>
  /** LLM 实例（实际未在 handler 直接用，但 scoreJob deps 需要） */
  llm: unknown
  /** 评分阈值 */
  threshold: number
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
      resumeSource: 'md'
      resumeWarnings: string[]
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
    if (err instanceof ResumeNotFoundError || err instanceof IncompleteResumeError) {
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

  // 3) 逐个处理
  for (const job of jobs) {
    try {
      const jd = await deps.fetchJobDetail(job.id)
      const score = await deps.scoreJob(jd, resume.summary, deps.llm)
      scored++

      const meetsThreshold = opts.noThreshold || score >= deps.threshold
      if (!meetsThreshold) continue

      passed++

      // dryRun 或 --no-write 都不调 createRecord
      if (!opts.write) continue

      const reason = `score=${score.toFixed(2)}`
      const fields: FeishuJobFields = {
        BOSS_ID: job.id,
        title: job.title,
        company: job.company,
        salary: job.salary,
        city: job.city ?? '',
        score,
        reason: reason.slice(0, REASON_MAX),
        jd_snippet: jd.slice(0, JD_SNIPPET_MAX),
        matchedAt: new Date().toISOString(),
      }
      await deps.createRecord(fields)
      written++
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
  }
}
