// ============================================================
// scoring — RED 测试 (Sprint 1A TDD Step 1)
// ============================================================
// 覆盖 2 个核心场景：
//   1. LLM 返有效 JSON {score: 0.91, reason: "..."} → scoreJob 返回 0.91
//   2. LLM 返无效 JSON → scoreJob 抛 ScoreParseError
//
// TDD 状态：RED（功能未实现，期望 2 个测试全部失败）
//
// Mock 策略：
//   - 不调真 LLM（必须 mock，避免 401 假绿）
//   - 用 vi.fn() 模拟 LLMAdapter.generate
// ============================================================

import { describe, it, expect, vi } from 'vitest'
import type { LLMAdapter } from '../llm/index.js'
import type { ResumeSummary } from '../types/index.js'

// ============================================================
// import 待实现模块（RED 阶段会因函数不存在而失败）
// ============================================================

import { scoreJob, ScoreParseError } from './index.js'

// ============================================================
// Fixture
// ============================================================

const SAMPLE_JD = `
【岗位描述】
高级前端工程师
要求：3 年以上 React 经验，熟悉 TypeScript
`

const SAMPLE_SUMMARY: ResumeSummary = {
  name: '张三',
  yearsOfExperience: 5,
  degree: '本科',
  school: '示例大学',
  isElite: false,
  isBigTech: false,
  skills: ['TypeScript', 'React', 'Node.js'],
  recentProjects: ['AI 自动投递简历助手'],
}

// ============================================================
// LLM mock 工厂
// ============================================================

function makeMockLLM(generateResult: string | Error): LLMAdapter {
  return {
    generate: vi.fn(async () => {
      if (generateResult instanceof Error) throw generateResult
      return generateResult
    }),
  }
}

// ============================================================
// TEST 4: LLM 返有效 JSON → 解析成功
// ============================================================

describe('scoreJob', () => {
  it('TEST 4: LLM 返回有效 JSON {score: 0.91, reason: "..."} → scoreJob 返回 0.91', async () => {
    // Arrange: LLM 返回结构化 JSON
    const llmJson = JSON.stringify({
      score: 0.91,
      reason: '候选人 React/TypeScript 经验与岗位高度匹配',
    })
    const llm = makeMockLLM(llmJson)

    // Act
    const score = await scoreJob(SAMPLE_JD, SAMPLE_SUMMARY, llm)

    // Assert: 返回 0.91（注意是 number，不是 string）
    expect(score).toBe(0.91)
    expect(typeof score).toBe('number')
  })

  // ============================================================
  // TEST 5: LLM 返无效 JSON → 抛错
  // ============================================================

  it('TEST 5: LLM 返回非 JSON 字符串 → scoreJob 抛 ScoreParseError', async () => {
    // Arrange: LLM 返回无效 JSON（带 markdown 代码块）
    const llm = makeMockLLM('这是我的评分：0.91 分，很匹配')

    // Act + Assert: 必须抛特定错误类
    await expect(scoreJob(SAMPLE_JD, SAMPLE_SUMMARY, llm)).rejects.toThrow(ScoreParseError)
  })

  it('TEST 5b: LLM 返回 JSON 但缺 score 字段 → scoreJob 抛 ScoreParseError', async () => {
    // Arrange: JSON 合法但字段不完整
    const llm = makeMockLLM(JSON.stringify({ reason: '匹配' }))

    // Act + Assert
    await expect(scoreJob(SAMPLE_JD, SAMPLE_SUMMARY, llm)).rejects.toThrow(ScoreParseError)
  })
})
