// ============================================================
// scoring/index — Sprint 1C RED 测试 (TDD Step 1，覆盖 1A + 新增 6 维)
// ============================================================
// 覆盖维度：
//   1. LLM 返有效 6 维 JSON → scoreJob 返 ScoreResult (totalScore + totalReason + dimensions)
//   2. LLM 返非 JSON → 抛 ScoreParseError
//   3. LLM 返 6 维 JSON 缺 1 维 → 部分降级（默认 0.5 + reason="维度解析失败"）+ 总分按降级后算
//   4. LLM 返某 1 维 score 越界 (>1) → 抛 ScoreParseError
//   5. LLM 返 totalScore 与本地重算不一致 → 本地重算覆盖（trust local arithmetic）
//   6. scoreJob 接受 weights 参数 → 按自定义权重算 totalScore
//   7. buildScorePrompt 输出含 6 维 rubric 关键词（防御 prompt 回归）
//
// TDD 状态：RED（scoreJob 签名已变 3→4 参数 + 新类型未导出 → 编译 + 运行时都失败）
// ============================================================

import { describe, it, expect, vi } from 'vitest'
import type { LLMAdapter } from '../llm/index.js'
import type { ResumeSummary } from '../types/index.js'

import { scoreJob, buildScorePrompt, ScoreParseError } from './index.js'
import { DEFAULT_WEIGHTS, type ScoreDimensions, type ScoreWeights } from './dimensions.js'

// ============================================================
// Fixture
// ============================================================

const SAMPLE_JD = `
【岗位描述】
高级 Java 后端工程师
要求：5 年以上 Java 经验，熟悉 Spring Cloud / Kafka / Redis
`

const SAMPLE_SUMMARY: ResumeSummary = {
  name: '张三',
  yearsOfExperience: 7,
  degree: '本科',
  school: '示例大学',
  isElite: false,
  isBigTech: true,
  skills: ['Java', 'Spring', 'Kafka', 'Redis'],
  recentProjects: ['万级 QPS 拍卖系统'],
}

// ============================================================
// 6 维有效 JSON fixture
// ============================================================

const FULL_6D: ScoreDimensions = {
  education: { score: 0.8, reason: '本科匹配' },
  experience: { score: 0.9, reason: '7 年 Java 经验' },
  skill: { score: 0.7, reason: '技能 80% 覆盖' },
  project: { score: 0.85, reason: '万级 QPS' },
  stability: { score: 0.6, reason: '5 年 3 跳' },
  potential: { score: 0.75, reason: '成长性好' },
}

// 期望 total = 0.8*0.1 + 0.9*0.3 + 0.7*0.1 + 0.85*0.3 + 0.6*0.1 + 0.75*0.1 = 0.81
const EXPECTED_TOTAL = 0.81

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
// TEST 1 (1C 重写 TEST 4): LLM 返有效 6 维 JSON → 返 ScoreResult
// ============================================================

describe('scoreJob', () => {
  it('TEST 1: LLM 返 6 维 JSON → scoreJob 返 ScoreResult (totalScore=0.81, totalReason, dimensions)', async () => {
    // Arrange: LLM 返 6 维 JSON（含 totalReason）
    const llmJson = JSON.stringify({ ...FULL_6D, totalReason: '总体匹配度高' })
    const llm = makeMockLLM(llmJson)

    // Act: 注意 scoreJob 新签名加了 weights 参数
    const result = await scoreJob(SAMPLE_JD, SAMPLE_SUMMARY, llm, DEFAULT_WEIGHTS)

    // Assert: ScoreResult 完整接口
    expect(result.totalScore).toBeCloseTo(EXPECTED_TOTAL, 3)
    expect(result.totalReason).toBe('总体匹配度高')
    expect(result.dimensions).toEqual(FULL_6D)
  })

  // ============================================================
  // TEST 2 (1C 重写 TEST 5): LLM 返非 JSON → 抛 ScoreParseError
  // ============================================================

  it('TEST 2: LLM 返回非 JSON 字符串 → scoreJob 抛 ScoreParseError', async () => {
    const llm = makeMockLLM('这是我的评分：0.91 分')

    await expect(
      scoreJob(SAMPLE_JD, SAMPLE_SUMMARY, llm, DEFAULT_WEIGHTS),
    ).rejects.toThrow(ScoreParseError)
  })

  // ============================================================
  // TEST 3 (1C 新增): 缺 1 维 → 部分降级（默认 0.5）+ 总分按降级后算
  // ============================================================
  // 降级规则（AI 假设，待 GREEN 确认）：单维缺失 → 默认 { score: 0.5, reason: "维度解析失败" }
  // 降级后总分 = 0.8*0.1 + 0.9*0.3 + 0.7*0.1 + 0.85*0.3 + 0.6*0.1 + 0.5*0.1
  //            = 0.08 + 0.27 + 0.07 + 0.255 + 0.06 + 0.05
  //            = 0.785

  it('TEST 3: LLM 返 6 维 JSON 缺 potential → 降级默认 0.5 + 总分按降级后算 = 0.785', async () => {
    // Arrange: 缺 potential 维度
    const partialJson = JSON.stringify({
      education: { score: 0.8, reason: '本科匹配' },
      experience: { score: 0.9, reason: '7 年 Java' },
      skill: { score: 0.7, reason: '技能匹配' },
      project: { score: 0.85, reason: '万级 QPS' },
      stability: { score: 0.6, reason: '稳定' },
      // potential 缺失
      totalReason: '基本匹配',
    })
    const llm = makeMockLLM(partialJson)

    // Act
    const result = await scoreJob(SAMPLE_JD, SAMPLE_SUMMARY, llm, DEFAULT_WEIGHTS)

    // Assert: potential 维度默认 0.5
    expect(result.dimensions.potential).toEqual({
      score: 0.5,
      reason: '维度解析失败',
    })
    expect(result.totalScore).toBeCloseTo(0.785, 3)
    expect(result.totalReason).toBe('基本匹配')
  })

  // ============================================================
  // TEST 4 (1C 新增): 某 1 维 score 越界 (>1) → 抛 ScoreParseError
  // ============================================================

  it('TEST 4: LLM 返某 1 维 score 越界 (1.5) → scoreJob 抛 ScoreParseError', async () => {
    // Arrange: education.score = 1.5 越界
    const invalidJson = JSON.stringify({
      ...FULL_6D,
      education: { score: 1.5, reason: '越界' },
    })
    const llm = makeMockLLM(invalidJson)

    await expect(
      scoreJob(SAMPLE_JD, SAMPLE_SUMMARY, llm, DEFAULT_WEIGHTS),
    ).rejects.toThrow(ScoreParseError)
  })

  // ============================================================
  // TEST 5 (1C 新增): LLM 返 totalScore 与本地重算不一致 → 本地覆盖
  // ============================================================

  it('TEST 5: LLM 返的 totalScore 与本地重算不一致 → 本地重算覆盖（trust local arithmetic）', async () => {
    // Arrange: LLM 故意返一个错的 totalScore（实际应是 0.81）
    const llmJson = JSON.stringify({
      ...FULL_6D,
      totalReason: '故意给低分',
      totalScore: 0.1, // 错的；本地重算应该是 0.81
    })
    const llm = makeMockLLM(llmJson)

    // Act
    const result = await scoreJob(SAMPLE_JD, SAMPLE_SUMMARY, llm, DEFAULT_WEIGHTS)

    // Assert: 本地重算覆盖（trust local）
    expect(result.totalScore).toBeCloseTo(EXPECTED_TOTAL, 3)
    expect(result.totalReason).toBe('故意给低分') // reason 保留 LLM 的
  })

  // ============================================================
  // TEST 6 (1C 新增): scoreJob 接受 weights 参数 → 按自定义权重算 totalScore
  // ============================================================

  it('TEST 6: scoreJob 接受 weights 参数 → 按自定义权重算 totalScore', async () => {
    // Arrange: 把所有权重给 experience
    const customWeights: ScoreWeights = {
      education: 0,
      experience: 1.0,
      skill: 0,
      project: 0,
      stability: 0,
      potential: 0,
    }

    const llmJson = JSON.stringify({ ...FULL_6D, totalReason: '经验主导' })
    const llm = makeMockLLM(llmJson)

    // Act
    const result = await scoreJob(SAMPLE_JD, SAMPLE_SUMMARY, llm, customWeights)

    // Assert: experience.score = 0.9 → total = 0.9
    expect(result.totalScore).toBeCloseTo(0.9, 3)
  })

  // ============================================================
  // TEST 7 (1C 新增): buildScorePrompt 输出含 6 维 rubric 关键词
  // ============================================================

  it('TEST 7: buildScorePrompt 必须含 6 维 rubric 关键词（防御 prompt 回归）', () => {
    const prompt = buildScorePrompt(SAMPLE_JD, SAMPLE_SUMMARY, DEFAULT_WEIGHTS)

    expect(prompt).toContain('学历')
    expect(prompt).toContain('经验')
    expect(prompt).toContain('技能')
    expect(prompt).toContain('项目')
    expect(prompt).toContain('稳定')
    expect(prompt).toContain('潜力')
    expect(prompt).toMatch(/JSON/i)
  })

  // ============================================================
  // TEST 8 (1C 异常处理): markdown 代码块包裹 → 正确剥离
  // ============================================================
  // 这是 parseScoreResponse 注释里明说的容错逻辑，必须有测试断言（防假绿）

  it('TEST 8: LLM 返 markdown ```json ... ``` 代码块 → parseScoreResponse 正确剥离', async () => {
    const llmJson =
      '```json\n' + JSON.stringify({ ...FULL_6D, totalReason: '代码块包裹' }) + '\n```'
    const llm = makeMockLLM(llmJson)

    const result = await scoreJob(SAMPLE_JD, SAMPLE_SUMMARY, llm, DEFAULT_WEIGHTS)

    expect(result.totalScore).toBeCloseTo(EXPECTED_TOTAL, 3)
    expect(result.totalReason).toBe('代码块包裹')
  })

  // ============================================================
  // TEST 9 (1C 异常处理): 前后空白 trim → 正确解析
  // ============================================================

  it('TEST 9: LLM 返前后带空白字符串 → parseScoreResponse 正确 trim', async () => {
    const llmJson =
      '   \n\n  ' + JSON.stringify({ ...FULL_6D, totalReason: '带空白' }) + '  \n  '
    const llm = makeMockLLM(llmJson)

    const result = await scoreJob(SAMPLE_JD, SAMPLE_SUMMARY, llm, DEFAULT_WEIGHTS)

    expect(result.totalScore).toBeCloseTo(EXPECTED_TOTAL, 3)
    expect(result.totalReason).toBe('带空白')
  })

  // ============================================================
  // TEST 10 (1C 参数校验): 单维 score 字符串类型 → 抛 ScoreParseError
  // ============================================================

  it('TEST 10: 单维 score 是字符串（如 "0.8"）→ scoreJob 抛 ScoreParseError', async () => {
    const invalidJson = JSON.stringify({
      ...FULL_6D,
      education: { score: '0.8', reason: '字符串类型错' }, // 应为 number
    })
    const llm = makeMockLLM(invalidJson)

    await expect(
      scoreJob(SAMPLE_JD, SAMPLE_SUMMARY, llm, DEFAULT_WEIGHTS),
    ).rejects.toThrow(ScoreParseError)
  })

  // ============================================================
  // TEST 11 (1C 参数校验): 单维 score 负数越界 → 抛 ScoreParseError
  // ============================================================

  it('TEST 11: 单维 score 负数（如 -0.1）→ scoreJob 抛 ScoreParseError', async () => {
    const invalidJson = JSON.stringify({
      ...FULL_6D,
      stability: { score: -0.1, reason: '负数越界' },
    })
    const llm = makeMockLLM(invalidJson)

    await expect(
      scoreJob(SAMPLE_JD, SAMPLE_SUMMARY, llm, DEFAULT_WEIGHTS),
    ).rejects.toThrow(ScoreParseError)
  })

  // ============================================================
  // TEST 12 (1C 重试逻辑): LLM 第一次抛网络错 → 重试 1 次 + 第二次成功
  // ============================================================
  // 智能分类：LLM 调用错误 → 重试；ScoreParseError → 不重试

  it('TEST 12: LLM 第一次抛网络错 → 重试 1 次 + 第二次成功 → 返 ScoreResult', async () => {
    // Arrange: 第一次 mockRejectedValueOnce（网络错），第二次 mockResolvedValueOnce（成功）
    const llm: LLMAdapter = {
      generate: vi
        .fn()
        .mockRejectedValueOnce(new Error('network timeout'))
        .mockResolvedValueOnce(
          JSON.stringify({ ...FULL_6D, totalReason: '重试成功' }),
        ),
    }

    // Act
    const result = await scoreJob(SAMPLE_JD, SAMPLE_SUMMARY, llm, DEFAULT_WEIGHTS)

    // Assert: 重试后成功
    expect(result.totalScore).toBeCloseTo(EXPECTED_TOTAL, 3)
    expect(result.totalReason).toBe('重试成功')
    // 关键：LLM 被调 2 次（首次失败 + 重试成功）
    expect(llm.generate).toHaveBeenCalledTimes(2)
  })

  // ============================================================
  // TEST 13 (1C 重试逻辑): LLM 两次都抛错 → 抛最后一次错误
  // ============================================================

  it('TEST 13: LLM 第一次和第二次都抛错 → scoreJob 抛最后一次错误（重试后仍失败）', async () => {
    // Arrange: 两次都失败
    const llm: LLMAdapter = {
      generate: vi
        .fn()
        .mockRejectedValueOnce(new Error('network timeout 1'))
        .mockRejectedValueOnce(new Error('network timeout 2')),
    }

    // Act + Assert: 抛最后一次错误
    await expect(
      scoreJob(SAMPLE_JD, SAMPLE_SUMMARY, llm, DEFAULT_WEIGHTS),
    ).rejects.toThrow('network timeout 2')
    expect(llm.generate).toHaveBeenCalledTimes(2)
  })
})
