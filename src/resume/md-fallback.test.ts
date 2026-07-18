// ============================================================
// md-fallback — RED 测试 (Sprint 1A TDD Step 1)
// ============================================================
// 覆盖 3 个核心场景：
//   1. MD 存在且完整 → 解析成功返回 ResumeSummary
//   2. MD 缺失 → 抛 NotFound
//   3. MD 缺核心字段（姓名/技能/工作年限 三选一） → 抛 IncompleteResumeError
//
// TDD 状态：RED（功能未实现，期望 3 个测试全部失败）
//   - import 会成功（类型已就位）
//   - 函数调用会抛 "function not implemented" 或类似
//
// Mock 策略：
//   - 用 vi.mock('node:fs') 拦截 readFileSync
//   - 不读真实磁盘，确保 CI 也能跑
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ============================================================
// 重要：必须用 vi.hoisted 让 mock 在 import 之前生效
// ============================================================

const { mockReadFileSync, mockExistsSync } = vi.hoisted(() => ({
  mockReadFileSync: vi.fn(),
  mockExistsSync: vi.fn(),
}))

vi.mock('node:fs', () => ({
  readFileSync: mockReadFileSync,
  existsSync: mockExistsSync,
}))

// ============================================================
// import 必须在 mock 之后
// ============================================================

import { readResumeMd, ResumeNotFoundError, IncompleteResumeError } from './md-fallback.js'

// ============================================================
// 测试用 fixture：完整 MD
// ============================================================

const VALID_MD = `## 姓名
张三

## 工作年限
5

## 学历
本科

## 技能
TypeScript, React, Node.js

## 近期项目
- AI 自动投递简历助手
- BOSS 协议逆向工具
`

const MD_MISSING_NAME = `## 工作年限
3

## 技能
Python, Django
`

const MD_MISSING_SKILLS = `## 姓名
李四

## 工作年限
2
`

const MD_MISSING_WORKYEAR = `## 姓名
王五

## 技能
Java, Spring
`

beforeEach(() => {
  vi.clearAllMocks()
})

// ============================================================
// TEST 1: MD 存在且完整 → ResumeSummary
// ============================================================

describe('readResumeMd', () => {
  it('TEST 1: MD 存在且完整 → 解析成功返回 ResumeSummary', () => {
    // Arrange: 文件存在 + 完整内容
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(VALID_MD)

    // Act
    const summary = readResumeMd('/tmp/test-resume.md')

    // Assert: 所有 5 个字段都正确解析
    expect(summary).toEqual({
      name: '张三',
      yearsOfExperience: 5,
      education: '本科',
      skills: ['TypeScript', 'React', 'Node.js'],
      recentProjects: ['AI 自动投递简历助手', 'BOSS 协议逆向工具'],
    })
  })

  // ============================================================
  // TEST 2: MD 缺失 → NotFound
  // ============================================================

  it('TEST 2: MD 文件不存在 → 抛 ResumeNotFoundError', () => {
    // Arrange: 文件不存在
    mockExistsSync.mockReturnValue(false)

    // Act + Assert: 必须抛特定错误类
    expect(() => readResumeMd('/tmp/nonexistent.md')).toThrow(ResumeNotFoundError)
  })

  // ============================================================
  // TEST 3: MD 缺核心字段 → IncompleteResumeError
  // ============================================================

  it('TEST 3a: MD 缺少姓名 → 抛 IncompleteResumeError', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(MD_MISSING_NAME)

    expect(() => readResumeMd('/tmp/no-name.md')).toThrow(IncompleteResumeError)
  })

  it('TEST 3b: MD 缺少技能 → 抛 IncompleteResumeError', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(MD_MISSING_SKILLS)

    expect(() => readResumeMd('/tmp/no-skills.md')).toThrow(IncompleteResumeError)
  })

  it('TEST 3c: MD 缺少工作年限 → 抛 IncompleteResumeError', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(MD_MISSING_WORKYEAR)

    expect(() => readResumeMd('/tmp/no-workyear.md')).toThrow(IncompleteResumeError)
  })
})
