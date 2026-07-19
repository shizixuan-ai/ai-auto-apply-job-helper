// ============================================================
// yaml-parser — RED 测试 (Sprint 1B TDD Step 1)
// ============================================================
// 覆盖 11 个核心场景：
//   1. 完整 yml 解析 → 拍平到 ResumeSummary
//   2. 文件不存在 → ResumeNotFoundError
//   3. 缺 姓名 → IncompleteResumeError
//   4. 缺 工作年限 → IncompleteResumeError
//   5. 缺 技能清单 → IncompleteResumeError
//   6. 缺 是否985_211 (顶层) → IncompleteResumeError
//   7. 缺 工作经历.是否大厂背景 → IncompleteResumeError
//   8. YAML 语法错 → ResumeParseError
//   9. 字段拍平正确（跨 section 映射）
//  10. 工作经历.经历 array of objects → 派生 recentProjects 字符串数组
//  11. 空手机号/邮箱 → 拍平为 undefined（不是 ""）
//
// TDD 状态：RED（功能未实现，期望 11 个测试全部失败 — import 会因模块不存在失败）
//
// Mock 策略：
//   - vi.mock('node:fs') 拦截 readFileSync + existsSync
//   - 用真实 YAML 字符串（不 mock yaml 包本身）— 走 Zod schema 真校验
//   - 不读真实磁盘
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ============================================================
// Mock node:fs（必须在 import yaml-parser 之前）
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

import {
  readResumeYaml,
  parseResumeYaml,
  ResumeNotFoundError,
  IncompleteResumeError,
  ResumeParseError,
} from './yaml-parser.js'

// ============================================================
// 测试 fixture：完整 yml（13 字段全填）
// ============================================================

const VALID_YAML = `
基础信息:
  姓名: 王积学
  性别: 男
  年龄: 30
  手机号: ""
  邮箱: ""

求职意向:
  目标岗位: Java 后端开发

教育背景:
  毕业院校: 华北理工大学
  学历层次: 本科
  专业名称: ""

是否985_211: false

工作经历:
  工作年限: 7
  是否大厂背景: false
  经历:
    - 公司: 优信拍
      时间段: "2023.09-2024.01"
      职位: 后端工程师
      描述: "竞价连拍系统，万级 QPS"
    - 公司: 掌阅科技
      时间段: "2025.07-2025.11"
      职位: 后端工程师
      描述: "海外文字推荐系统"

技能清单:
  - Java
  - JVM
  - Spring

自我介绍: |
  7 年 Java 后端。
`

// ============================================================
// 各必填字段缺失的 fixture
// ============================================================

const YAML_MISSING_NAME = `
基础信息:
  年龄: 30                  # 块在但缺 姓名
是否985_211: false
工作经历:
  工作年限: 7
  是否大厂背景: false
技能清单:
  - Java
`

const YAML_MISSING_YEARS = `
基础信息:
  姓名: 张三
是否985_211: false
工作经历:
  是否大厂背景: false
技能清单:
  - Java
`

const YAML_MISSING_SKILLS = `
基础信息:
  姓名: 张三
是否985_211: false
工作经历:
  工作年限: 7
  是否大厂背景: false
`

const YAML_MISSING_IS_ELITE = `
基础信息:
  姓名: 张三
工作经历:
  工作年限: 7
  是否大厂背景: false
技能清单:
  - Java
`

const YAML_MISSING_IS_BIG_TECH = `
基础信息:
  姓名: 张三
是否985_211: false
工作经历:
  工作年限: 7
技能清单:
  - Java
`

const BROKEN_YAML = `
基础信息:
  姓名: "张三
  : bad indent
  :: :
`

// ============================================================
// beforeEach 重置 mock
// ============================================================

beforeEach(() => {
  vi.clearAllMocks()
})

// ============================================================
// TEST 1: 完整 yml 解析 → 拍平到 ResumeSummary
// ============================================================

describe('readResumeYaml', () => {
  it('TEST 1: 完整 yml 解析 → 拍平到 ResumeSummary（13 字段）', () => {
    // Arrange
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(VALID_YAML)

    // Act
    const summary = readResumeYaml('/tmp/test-resume.yml')

    // Assert：13 字段都正确拍平
    expect(summary).toEqual({
      name: '王积学',
      gender: '男',
      age: 30,
      phone: undefined,           // 空字符串 → undefined
      email: undefined,
      targetRole: 'Java 后端开发',
      school: '华北理工大学',
      degree: '本科',
      major: undefined,
      isElite: false,
      yearsOfExperience: 7,
      isBigTech: false,
      recentProjects: [
        '优信拍 - 2023.09-2024.01 - 后端工程师 - 竞价连拍系统，万级 QPS',
        '掌阅科技 - 2025.07-2025.11 - 后端工程师 - 海外文字推荐系统',
      ],
      skills: ['Java', 'JVM', 'Spring'],
      workSummary: '7 年 Java 后端。',
    })
  })

  // ============================================================
  // TEST 2: 文件不存在
  // ============================================================

  it('TEST 2: 文件不存在 → 抛 ResumeNotFoundError', () => {
    mockExistsSync.mockReturnValue(false)

    expect(() => readResumeYaml('/tmp/nonexistent.yml')).toThrow(ResumeNotFoundError)
  })

  // ============================================================
  // TEST 3: 缺 姓名
  // ============================================================

  it('TEST 3: 缺 基础信息.姓名 → 抛 IncompleteResumeError', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(YAML_MISSING_NAME)

    try {
      readResumeYaml('/tmp/no-name.yml')
      expect.fail('应抛 IncompleteResumeError')
    } catch (err) {
      expect(err).toBeInstanceOf(IncompleteResumeError)
      expect((err as IncompleteResumeError).missing).toContain('姓名')
    }
  })

  // ============================================================
  // TEST 4: 缺 工作年限
  // ============================================================

  it('TEST 4: 缺 工作经历.工作年限 → 抛 IncompleteResumeError', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(YAML_MISSING_YEARS)

    try {
      readResumeYaml('/tmp/no-years.yml')
      expect.fail('应抛 IncompleteResumeError')
    } catch (err) {
      expect(err).toBeInstanceOf(IncompleteResumeError)
      expect((err as IncompleteResumeError).missing).toContain('工作年限')
    }
  })

  // ============================================================
  // TEST 5: 缺 技能清单
  // ============================================================

  it('TEST 5: 缺 技能清单 → 抛 IncompleteResumeError', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(YAML_MISSING_SKILLS)

    try {
      readResumeYaml('/tmp/no-skills.yml')
      expect.fail('应抛 IncompleteResumeError')
    } catch (err) {
      expect(err).toBeInstanceOf(IncompleteResumeError)
      expect((err as IncompleteResumeError).missing).toContain('技能清单')
    }
  })

  // ============================================================
  // TEST 6: 缺 顶层 是否985_211
  // ============================================================

  it('TEST 6: 缺 顶层 是否985_211 → 抛 IncompleteResumeError', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(YAML_MISSING_IS_ELITE)

    try {
      readResumeYaml('/tmp/no-elite.yml')
      expect.fail('应抛 IncompleteResumeError')
    } catch (err) {
      expect(err).toBeInstanceOf(IncompleteResumeError)
      expect((err as IncompleteResumeError).missing).toContain('是否985_211')
    }
  })

  // ============================================================
  // TEST 7: 缺 工作经历.是否大厂背景
  // ============================================================

  it('TEST 7: 缺 工作经历.是否大厂背景 → 抛 IncompleteResumeError', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(YAML_MISSING_IS_BIG_TECH)

    try {
      readResumeYaml('/tmp/no-bigtech.yml')
      expect.fail('应抛 IncompleteResumeError')
    } catch (err) {
      expect(err).toBeInstanceOf(IncompleteResumeError)
      expect((err as IncompleteResumeError).missing).toContain('是否大厂背景')
    }
  })

  // ============================================================
  // TEST 8: YAML 语法错
  // ============================================================

  it('TEST 8: YAML 语法错 → 抛 ResumeParseError', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(BROKEN_YAML)

    expect(() => readResumeYaml('/tmp/broken.yml')).toThrow(ResumeParseError)
  })

  // ============================================================
  // TEST 9: 字段拍平（跨 section）
  // ============================================================

  it('TEST 9: 字段拍平跨 section 映射正确（教育背景/求职意向/工作经历）', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(VALID_YAML)

    const summary = readResumeYaml('/tmp/flat.yml')

    // 基础信息 → name/gender/age
    expect(summary.name).toBe('王积学')
    expect(summary.gender).toBe('男')
    expect(summary.age).toBe(30)
    // 求职意向 → targetRole
    expect(summary.targetRole).toBe('Java 后端开发')
    // 教育背景 → school/degree
    expect(summary.school).toBe('华北理工大学')
    expect(summary.degree).toBe('本科')
    // 工作经历 → yearsOfExperience
    expect(summary.yearsOfExperience).toBe(7)
    // 顶层 → isElite；工作经历 → isBigTech
    expect(summary.isElite).toBe(false)
    expect(summary.isBigTech).toBe(false)
  })

  // ============================================================
  // TEST 10: 工作经历.经历 array of objects → recentProjects 字符串数组
  // ============================================================

  it('TEST 10: 工作经历.经历 array of objects → recentProjects 字符串数组', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(VALID_YAML)

    const summary = readResumeYaml('/tmp/work-history.yml')

    // recentProjects 应该是字符串数组（用于搜索结果显示，不破坏 JobSummary 形状）
    expect(summary.recentProjects).toEqual([
      '优信拍 - 2023.09-2024.01 - 后端工程师 - 竞价连拍系统，万级 QPS',
      '掌阅科技 - 2025.07-2025.11 - 后端工程师 - 海外文字推荐系统',
    ])
  })

  // ============================================================
  // TEST 11: 空手机号/邮箱 → undefined（不是 ""）
  // ============================================================

  it('TEST 11: 空手机号/邮箱 → 拍平为 undefined（避免下游 falsy 检查被 "" 干扰）', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(VALID_YAML)

    const summary = readResumeYaml('/tmp/empty-contact.yml')

    expect(summary.phone).toBeUndefined()
    expect(summary.email).toBeUndefined()
    // 显式断言不是空串
    expect(summary.phone).not.toBe('')
    expect(summary.email).not.toBe('')
  })
})

// ============================================================
// parseResumeYaml（纯函数：不读盘）
// ============================================================

describe('parseResumeYaml', () => {
  it('TEST 12: parseResumeYaml(VALID_YAML) 直接拍平返回 ResumeSummary', () => {
    const summary = parseResumeYaml(VALID_YAML)
    expect(summary.name).toBe('王积学')
    expect(summary.skills).toEqual(['Java', 'JVM', 'Spring'])
  })
})
