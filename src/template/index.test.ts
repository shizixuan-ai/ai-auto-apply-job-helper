// ============================================================
// template 单元测试
// ============================================================
// Sprint B-1：业务层测试补齐（path A → B → C）
//
// template 是纯函数，无副作用，全部直接断言。
// ============================================================

import { describe, it, expect } from 'vitest'
import {
  buildGreetingSystemPrompt,
  buildGreetingPrompt,
  buildResumeSummary,
} from './index.js'

describe('buildGreetingSystemPrompt', () => {
  it('返回的 prompt 包含核心约束（200 字内、真诚、不模板）', () => {
    const prompt = buildGreetingSystemPrompt()

    // 关键约束关键词
    expect(prompt).toMatch(/200\s*字/)
    expect(prompt).toMatch(/真诚/)
    expect(prompt).toMatch(/打招呼/)
  })

  it('明确禁止模板化输出', () => {
    const prompt = buildGreetingSystemPrompt()

    // 应包含"不要像模板"或类似措辞
    expect(prompt).toMatch(/不要.*模板|不要.*前缀|不要.*附件/)
  })
})

describe('buildGreetingPrompt', () => {
  it('同时包含 JD 和 简历摘要', () => {
    const jd = '【岗位职责】\n负责前端架构设计与代码 review'
    const resume = '姓名: 张三\n技能: TypeScript, React'

    const prompt = buildGreetingPrompt(jd, resume)

    expect(prompt).toContain(jd)
    expect(prompt).toContain(resume)
  })

  it('使用结构化分隔符（岗位描述 / 我的简历摘要）', () => {
    const prompt = buildGreetingPrompt('JD 内容', '简历内容')

    // 应有清晰章节
    expect(prompt).toMatch(/岗位描述/)
    expect(prompt).toMatch(/简历摘要/)
  })
})

describe('buildResumeSummary', () => {
  it('空 resume 返回空字符串', () => {
    expect(buildResumeSummary({})).toBe('')
  })

  it('只输出有值的字段（跳过 undefined）', () => {
    const summary = buildResumeSummary({
      name: '张三',
      // yearsOfExperience 不传
      skills: ['TypeScript', 'React'],
    })

    expect(summary).toContain('姓名: 张三')
    expect(summary).toContain('技能: TypeScript, React')
    expect(summary).not.toContain('工作经验') // 未传，不应出现
    expect(summary).not.toContain('学历') // 未传，不应出现
  })

  it('projects 用 markdown bullet 列表渲染', () => {
    const summary = buildResumeSummary({
      recentProjects: ['项目 A', '项目 B'],
    })

    expect(summary).toContain('近期项目')
    expect(summary).toMatch(/- 项目 A/)
    expect(summary).toMatch(/- 项目 B/)
  })

  it('所有字段都填时输出完整', () => {
    const summary = buildResumeSummary({
      name: '李四',
      yearsOfExperience: 5,
      skills: ['Go', 'Kubernetes'],
      education: '硕士',
      recentProjects: ['分布式存储网关'],
    })

    expect(summary).toContain('姓名: 李四')
    expect(summary).toContain('工作经验: 5年')
    expect(summary).toContain('学历: 硕士')
    expect(summary).toContain('技能: Go, Kubernetes')
    expect(summary).toContain('- 分布式存储网关')
  })
})