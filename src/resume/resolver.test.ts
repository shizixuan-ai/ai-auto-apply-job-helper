// ============================================================
// resolver — RED 测试 (Sprint 1A CLI 接入 TDD Step 1)
// ============================================================
// 覆盖 1 个核心场景：
//   1. resolveResume() 调 readResumeMd，返 {summary, source: 'md', warnings: []}
//
// TDD 状态：RED（resolver 未实现）
//
// Mock 策略：mock md-fallback 模块的 readResumeMd
// ============================================================

import { describe, it, expect, vi } from 'vitest'

// ============================================================
// 1. mock md-fallback 模块（在 import resolver 之前）
// ============================================================

vi.mock('./md-fallback.js', () => ({
  readResumeMd: vi.fn(),
  ResumeNotFoundError: class ResumeNotFoundError extends Error {},
  IncompleteResumeError: class IncompleteResumeError extends Error {
    readonly missing: string[] = []
  },
}))

// ============================================================
// 2. import resolver（被测目标）
// ============================================================

import { resolveResume } from './resolver.js'
import { readResumeMd, ResumeNotFoundError, IncompleteResumeError } from './md-fallback.js'

const mockedReadResumeMd = vi.mocked(readResumeMd)

// ============================================================
// TEST: resolveResume 调 readResumeMd 并包装返回
// ============================================================

describe('resolveResume', () => {
  it('调 readResumeMd 解析本地 MD，返 {summary, source:"md", warnings:[]}', async () => {
    // Arrange
    const fakeSummary = {
      name: '张三',
      yearsOfExperience: 5,
      education: '本科',
      skills: ['TypeScript', 'React'],
      recentProjects: ['AI 助手'],
    }
    mockedReadResumeMd.mockReturnValue(fakeSummary as any)

    // Act
    const result = await resolveResume()

    // Assert
    expect(mockedReadResumeMd).toHaveBeenCalledTimes(1)
    expect(result).toEqual({
      summary: fakeSummary,
      source: 'md',
      warnings: [],
    })
  })

  it('readResumeMd 抛 ResumeNotFoundError → 透传（让 handler 捕获并返 action: error）', async () => {
    // Arrange
    mockedReadResumeMd.mockImplementation(() => {
      throw new ResumeNotFoundError('简历.md')
    })

    // Act + Assert
    await expect(resolveResume()).rejects.toThrow(ResumeNotFoundError)
  })

  it('readResumeMd 抛 IncompleteResumeError → 透传', async () => {
    // Arrange
    mockedReadResumeMd.mockImplementation(() => {
      throw new IncompleteResumeError(['姓名'])
    })

    // Act + Assert
    await expect(resolveResume()).rejects.toThrow(IncompleteResumeError)
  })
})
