// ============================================================
// resolver — Sprint 1B 强切到 YAML 路径
// ============================================================
// 1A 阶段：只调 readResumeMd（path 默认 '简历.md'）
// 1B 阶段（当前）：强切到 readResumeYaml（path 默认 '简历.yml'）
//   - 不再 fallback 到 MD（强切语义）
//   - 推断字段（isElite / isBigTech）由候选人手填，resolver 不再尝试 BOSS API 补充
//
// 透传策略：
//   - readResumeYaml 抛 ResumeNotFoundError / IncompleteResumeError / ResumeParseError
//     → 透传（让 handler 捕获并返 action: 'error'）
//   - 1B 阶段不主动捕错、不吞错
// ============================================================

import { readResumeYaml } from './yaml-parser.js'
export {
  ResumeNotFoundError,
  IncompleteResumeError,
  ResumeParseError,
} from './yaml-parser.js'
import type { ResumeSummary } from '../types/index.js'

/** 简历解析结果 */
export interface ResumeResolution {
  summary: ResumeSummary
  /** 简历来源（Sprint 1B 固定 'yaml'）*/
  source: 'yaml'
  /** 警告（缺非必填字段等；1B 阶段固定 []） */
  warnings: string[]
}

/**
 * 解析简历主入口
 *
 * 1B 行为：只调 readResumeYaml（path 默认 '简历.yml'）
 *
 * @throws ResumeNotFoundError 文件不存在
 * @throws IncompleteResumeError 缺必填字段
 * @throws ResumeParseError YAML 语法错 / schema 校验失败
 */
export async function resolveResume(path?: string): Promise<ResumeResolution> {
  const summary = readResumeYaml(path)

  return {
    summary,
    source: 'yaml',
    warnings: [],
  }
}
