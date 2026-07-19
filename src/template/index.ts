// ============================================================
// 话术模板生成逻辑
// ============================================================
// 职责：将简历 + JD 组合成话术生成提示词，供 LLM 适配器使用。
// ============================================================

import type { Job } from '../types/index.js'

/** 构建话术生成的系统提示词 */
export function buildGreetingSystemPrompt(): string {
  return `你是一名正在申请工作的求职者。你需要根据招聘方的岗位描述和你的个人简历，
生成一段简短、真诚、有针对性的"打招呼"消息。
要求：
- 语气自然，不要像模板
- 突出你与岗位的匹配点
- 控制在 200 字以内
- 不要包含附件、简历等字眼
- 直接输出话术内容，不要有前缀说明`
}

/** 构建话术生成的用户提示词 */
export function buildGreetingPrompt(jd: string, resumeSummary: string): string {
  return `【岗位描述】
${jd}

【我的简历摘要】
${resumeSummary}

请根据以上信息，生成一段打招呼消息。`
}

/** 构建简历摘要（从配置中的简历信息提取） */
export function buildResumeSummary(resume: {
  name?: string
  yearsOfExperience?: number
  skills?: string[]
  /** Sprint 1B：education 拆分为 school + degree */
  school?: string
  degree?: '本科' | '硕士' | '博士' | '其他'
  major?: string
  /** Sprint 1B：新增字段 */
  gender?: '男' | '女' | '未知'
  age?: number
  targetRole?: string
  isElite?: boolean
  isBigTech?: boolean
  recentProjects?: string[]
  workSummary?: string
}): string {
  const parts: string[] = []
  if (resume.name) parts.push(`姓名: ${resume.name}`)
  if (resume.gender) parts.push(`性别: ${resume.gender}`)
  if (resume.age) parts.push(`年龄: ${resume.age}`)
  if (resume.yearsOfExperience) parts.push(`工作经验: ${resume.yearsOfExperience}年`)
  if (resume.degree) parts.push(`学历: ${resume.degree}`)
  if (resume.school) parts.push(`毕业院校: ${resume.school}`)
  if (resume.major) parts.push(`专业: ${resume.major}`)
  if (resume.isElite !== undefined) parts.push(`是否985/211: ${resume.isElite ? '是' : '否'}`)
  if (resume.isBigTech !== undefined) parts.push(`是否大厂背景: ${resume.isBigTech ? '是' : '否'}`)
  if (resume.targetRole) parts.push(`求职意向: ${resume.targetRole}`)
  if (resume.skills?.length) parts.push(`技能: ${resume.skills.join(', ')}`)
  if (resume.recentProjects?.length) {
    parts.push(`近期项目:\n${resume.recentProjects.map(p => `- ${p}`).join('\n')}`)
  }
  if (resume.workSummary) parts.push(`自我介绍: ${resume.workSummary}`)
  return parts.join('\n')
}
