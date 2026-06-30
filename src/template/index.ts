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
  education?: string
  recentProjects?: string[]
}): string {
  const parts: string[] = []
  if (resume.name) parts.push(`姓名: ${resume.name}`)
  if (resume.yearsOfExperience) parts.push(`工作经验: ${resume.yearsOfExperience}年`)
  if (resume.education) parts.push(`学历: ${resume.education}`)
  if (resume.skills?.length) parts.push(`技能: ${resume.skills.join(', ')}`)
  if (resume.recentProjects?.length) {
    parts.push(`近期项目:\n${resume.recentProjects.map(p => `- ${p}`).join('\n')}`)
  }
  return parts.join('\n')
}
