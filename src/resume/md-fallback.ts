// ============================================================
// md-fallback — Sprint 1A GREEN
// ============================================================
// 从本地 MD 文件解析简历摘要（H2 分段）
//
// 格式约定（docs/resume-format.md 待 Sprint 1C 补全）：
//   ## 姓名
//   张三
//
//   ## 工作年限
//   5
//
//   ## 学历
//   本科
//
//   ## 技能
//   TypeScript, React, Node.js
//
//   ## 近期项目
//   - 项目1
//   - 项目2
//
// 设计决策：
//   - 必填字段：name, skills, yearsOfExperience（其余 optional）
//   - 缺必填 → IncompleteResumeError
//   - 文件不存在 → ResumeNotFoundError
//   - 工作年限：必须是数字；非数字 → IncompleteResumeError
//   - 技能：逗号分隔，转数组；去空、去重
//   - 近期项目：以 "- " 开头的行；可为空
// ============================================================

import { readFileSync, existsSync } from 'node:fs'
import type { ResumeSummary } from '../types/index.js'

/** 默认简历路径（项目根 简历.md） */
export const DEFAULT_RESUME_MD_PATH = '简历.md'

// ============================================================
// 错误类型
// ============================================================

/** 简历 MD 文件不存在 */
export class ResumeNotFoundError extends Error {
  constructor(path: string) {
    super(`简历文件不存在：${path}（请创建 简历.md 或指定 --resume <path>）`)
    this.name = 'ResumeNotFoundError'
  }
}

/** 简历 MD 缺少必填字段（name / skills / yearsOfExperience） */
export class IncompleteResumeError extends Error {
  readonly missing: string[]
  constructor(missing: string[]) {
    super(`简历缺少必填字段：${missing.join('、')}（至少需要 姓名 + 工作年限 + 技能）`)
    this.name = 'IncompleteResumeError'
    this.missing = missing
  }
}

// ============================================================
// 解析逻辑
// ============================================================

/**
 * 解析 MD 内容为 ResumeSummary
 * 纯函数（不读盘），便于单测
 */
export function parseResumeMd(content: string): ResumeSummary {
  const sections = parseH2Sections(content)

  // 姓名
  const name = sections['姓名']?.trim() || undefined

  // 工作年限（必须为数字）
  let yearsOfExperience: number | undefined
  const yearsRaw = sections['工作年限']?.trim()
  if (yearsRaw) {
    const n = Number(yearsRaw)
    yearsOfExperience = Number.isFinite(n) ? n : undefined
  }

  // 学历（optional）
  const education = sections['学历']?.trim() || undefined

  // 技能（逗号分隔）
  const skillsRaw = sections['技能']?.trim()
  const skills = skillsRaw
    ? skillsRaw.split(/[,，]/).map((s) => s.trim()).filter(Boolean)
    : undefined

  // 近期项目（- 列表）
  const projectsRaw = sections['近期项目']?.trim()
  const recentProjects = projectsRaw
    ? projectsRaw
        .split('\n')
        .map((line) => line.replace(/^-\s*/, '').trim())
        .filter(Boolean)
    : undefined

  // 校验必填字段
  const missing: string[] = []
  if (!name) missing.push('姓名')
  if (yearsOfExperience === undefined) missing.push('工作年限')
  if (!skills || skills.length === 0) missing.push('技能')

  if (missing.length > 0) {
    throw new IncompleteResumeError(missing)
  }

  return {
    name,
    yearsOfExperience,
    education,
    skills: skills!,
    recentProjects,
  }
}

/**
 * 将 MD 内容按 H2 标题切分为 map
 *   "## 姓名\n张三\n\n## 技能\nTS" → { 姓名: "张三", 技能: "TS" }
 */
function parseH2Sections(content: string): Record<string, string> {
  const lines = content.split('\n')
  const sections: Record<string, string> = {}
  let currentKey: string | null = null
  let currentLines: string[] = []

  const flush = () => {
    if (currentKey !== null) {
      sections[currentKey] = currentLines.join('\n').trim()
    }
  }

  for (const line of lines) {
    const m = line.match(/^##\s+(.+)$/)
    if (m) {
      flush()
      currentKey = m[1]!.trim()
      currentLines = []
    } else if (currentKey !== null) {
      currentLines.push(line)
    }
  }
  flush()

  return sections
}

// ============================================================
// 入口：读盘 + 解析
// ============================================================

/**
 * 读指定路径的 MD 简历并解析
 * @throws ResumeNotFoundError 文件不存在
 * @throws IncompleteResumeError 缺必填字段
 */
export function readResumeMd(path: string = DEFAULT_RESUME_MD_PATH): ResumeSummary {
  if (!existsSync(path)) {
    throw new ResumeNotFoundError(path)
  }
  const content = readFileSync(path, 'utf8')
  return parseResumeMd(content)
}
