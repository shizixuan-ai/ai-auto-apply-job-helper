// ============================================================
// resolver — Sprint 1A 简单版（CLI 接入 GREEN）
// ============================================================
// 1A 只接 MD 本地简历；1B 再加 BOSS API 补充。
//
// 透传策略：
//   - readResumeMd 抛 ResumeNotFoundError / IncompleteResumeError
//     → 透传（让 handler 捕获并返 action: 'error'）
//   - 1A 阶段不主动捕错、不吞错
// ============================================================

import { readResumeMd } from './md-fallback.js'
export { ResumeNotFoundError, IncompleteResumeError } from './md-fallback.js'
import type { ResumeSummary } from '../types/index.js'

/** 简历解析结果 */
export interface ResumeResolution {
  summary: ResumeSummary
  /** 简历来源（1A 固定 'md'） */
  source: 'md'
  /** 警告（缺非必填字段、API 补充失败等） */
  warnings: string[]
}

/**
 * 解析简历主入口
 *
 * 1A 行为：只调 readResumeMd（path 默认 '简历.md'）
 * 1B 行为：先 MD，再尝试 BOSS API 补充 skills/education
 *
 * @throws ResumeNotFoundError 文件不存在
 * @throws IncompleteResumeError 缺必填字段
 */
export async function resolveResume(path?: string): Promise<ResumeResolution> {
  const summary = readResumeMd(path)

  return {
    summary,
    source: 'md',
    warnings: [],
  }
}
