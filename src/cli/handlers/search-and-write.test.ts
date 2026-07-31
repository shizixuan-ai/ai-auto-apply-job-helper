// ============================================================
// runSearchAndWrite — RED 测试 (Sprint 1A TDD Step 1)
// ============================================================
// 覆盖 1 个核心场景：
//   1. scoreJob 抛错时 → 该 job 计入 failed，整体继续跑后续 job
//
// TDD 状态：RED（功能未实现，期望测试失败）
//
// Mock 策略：
//   - 通过 deps 注入 5 个依赖（searchJobs / fetchJobDetail / scoreJob / createRecord / resolveResume）
//   - 不调真浏览器 / 真 LLM / 真飞书
// ============================================================

import { describe, it, expect, vi } from 'vitest'

import { runSearchAndWrite } from './search-and-write.js'
import type { Job, ScoreResult } from '../../types/index.js'

// ============================================================
// Fixture: 2 个 job（强制类型为 Job，省略必填字段以聚焦测试）
// ============================================================

const JOB_A = {
  id: 'jobA_encryptedId',
  title: '高级前端工程师',
  company: '阿里',
  salary: '30-50K',
  city: '杭州',
  experience: '3-5 年',
  degree: '本科',
  brandStage: '',
  brandIndustry: '',
  brandScale: '',
  welfare: [],
  skills: [],
  link: '',
} as unknown as Job

const JOB_B = {
  ...JOB_A,
  id: 'jobB_encryptedId',
  title: '资深前端架构师',
  company: '字节',
}

const SAMPLE_RESUME = {
  name: '张三',
  yearsOfExperience: 5,
  degree: '本科' as const,
  skills: ['TypeScript', 'React'],
  recentProjects: [],
}

/**
 * Sprint 1C：构造 mock ScoreResult（替换老的 mock number 0.92）
 * - totalScore: 0.92（与 Sprint 1A 行为兼容，过 0.85 阈值）
 * - dimensions: 6 维全填（方便断言 六维详情 JSON 内容）
 */
function makeMockScoreResult(score = 0.92): ScoreResult {
  return {
    totalScore: score,
    totalReason: `mock score ${score}`,
    dimensions: {
      education: { score: 0.8, reason: 'mock edu' },
      experience: { score: 0.9, reason: 'mock exp' },
      skill: { score: 0.7, reason: 'mock skill' },
      project: { score: 0.85, reason: 'mock proj' },
      stability: { score: 0.6, reason: 'mock stab' },
      potential: { score: 0.75, reason: 'mock pot' },
    },
  }
}

// ============================================================
// TEST 6: scoreJob 抛错时 → 该 job failed，整体继续
// ============================================================

describe('runSearchAndWrite', () => {
  it('TEST 6: scoreJob 对 jobA 抛错 → jobA 计入 failed，jobB 仍正常写入', async () => {
    // Arrange
    const deps = {
      searchJobs: vi.fn(async () => [JOB_A, JOB_B]),
      fetchJobDetail: vi.fn(async (jobId: string) =>
        jobId === 'jobA_encryptedId' ? 'JD for A' : 'JD for B',
      ),
      scoreJob: vi.fn(async (jd: string) => {
        if (jd === 'JD for A') {
          throw new Error('LLM 返回无效 JSON')
        }
        return makeMockScoreResult(0.92) // jobB 通过
      }),
      createRecord: vi.fn(async () => ({ record_id: 'rec_new' })),
      resolveResume: vi.fn(async () => ({ summary: SAMPLE_RESUME, source: 'yaml' as const, warnings: [] })),
      llm: {} as unknown,                          // 占位（scoreJob deps 不真用）
      threshold: 0.85,
    }

    // Act
    const result = await runSearchAndWrite(
      {
        keyword: '前端',
        city: '杭州',
        write: true,
        dryRun: false,
        noThreshold: false,
        limit: 10,
      },
      deps,
    )

    // Assert
    expect(result.action).toBe('ok')
    if (result.action !== 'ok') throw new Error('result is not ok')

    expect(result.total).toBe(2)
    expect(result.failed).toBe(1)     // jobA 失败
    expect(result.scored).toBe(1)     // jobB 评分成功
    expect(result.passed).toBe(1)     // jobB 过阈值
    expect(result.written).toBe(1)    // jobB 写入成功

    // 关键：createRecord 只被调用 1 次（jobB），jobA 失败时没调
    expect(deps.createRecord).toHaveBeenCalledTimes(1)
    expect(deps.createRecord).toHaveBeenCalledWith(
      expect.objectContaining({ BOSS_ID: 'jobB_encryptedId' }),
    )
    expect(deps.createRecord).toHaveBeenCalledWith(
      expect.objectContaining({ 职位: '资深前端架构师' }),
    )
    // 假绿防御：必须断言 4 个新字段（公司/分数/匹配原因/JD摘要/匹配时间）
    expect(deps.createRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        公司: '字节',
        分数: 0.92,
        匹配原因: 'score=0.92',
        匹配时间: expect.any(Number),
      }),
    )
    // JD摘要 是 jd 字符串前 200 字（test fixture 中 jobB 的 jd='JD for B'）
    const actualCall = (deps.createRecord as any).mock.calls[0][0]
    expect(actualCall.JD摘要).toBe('JD for B')

    // Sprint 1C：六维详情 = formatDimensionsForFeishu(ScoreResult) 的 JSON 输出
    // 必须包含 6 维字段名 + totalReason，且 parse 回去能拿到完整数据
    expect(actualCall['六维详情']).toEqual(expect.any(String))
    const parsed6D = JSON.parse(actualCall['六维详情'])
    expect(parsed6D.dimensions.education.score).toBe(0.8)
    expect(parsed6D.dimensions.experience.score).toBe(0.9)
    expect(parsed6D.dimensions.skill.score).toBe(0.7)
    expect(parsed6D.dimensions.project.score).toBe(0.85)
    expect(parsed6D.dimensions.stability.score).toBe(0.6)
    expect(parsed6D.dimensions.potential.score).toBe(0.75)
    expect(parsed6D.totalReason).toContain('mock score 0.92')
  })

  // ----------------------------------------------------------
  // TEST 7: Sprint 2B — HR_UID 字段透传（写飞书）
  // ----------------------------------------------------------

  it('TEST 7: job.hrUid 有值时 → createRecord fields 含 HR_UID（sync 后续读取用）', async () => {
    // Arrange: jobA 带 hrUid, jobB 不带
    const JOB_A_WITH_HRUID = {
      ...JOB_A,
      hrUid: 'hr_enc_aaa',
    } as unknown as Job
    const deps = {
      searchJobs: vi.fn(async () => [JOB_A_WITH_HRUID, JOB_B]),
      fetchJobDetail: vi.fn(async (jobId: string) =>
        jobId === 'jobA_encryptedId' ? 'JD for A' : 'JD for B',
      ),
      scoreJob: vi.fn(async () => makeMockScoreResult(0.92)), // 都通过
      createRecord: vi.fn(async () => ({ record_id: 'rec_new' })),
      resolveResume: vi.fn(async () => ({ summary: SAMPLE_RESUME, source: 'yaml' as const, warnings: [] })),
      llm: {} as unknown,
      threshold: 0.85,
    }

    // Act
    await runSearchAndWrite(
      { keyword: '前端', city: '杭州', write: true, dryRun: false, noThreshold: false, limit: 10 },
      deps,
    )

    // Assert: 2 个 createRecord call
    expect(deps.createRecord).toHaveBeenCalledTimes(2)

    // jobA 应该有 HR_UID
    const jobACall = (deps.createRecord as any).mock.calls.find(
      (c: any[]) => c[0].BOSS_ID === 'jobA_encryptedId',
    )
    expect(jobACall).toBeDefined()
    expect(jobACall[0].HR_UID).toBe('hr_enc_aaa')

    // jobB 不带 hrUid → fields 中不应有 HR_UID 键（避免 undefined 写入飞书）
    const jobBCall = (deps.createRecord as any).mock.calls.find(
      (c: any[]) => c[0].BOSS_ID === 'jobB_encryptedId',
    )
    expect(jobBCall).toBeDefined()
    expect('HR_UID' in jobBCall[0]).toBe(false)
  })

  // ----------------------------------------------------------
  // TEST 8: Sprint C (ADR-0008) — LID + SECURITY_ID 字段透传（解锁 auto-greet）
  // ----------------------------------------------------------
  // 行为契约（ADR-0008 §6）：
  //   - job.lid 有值时 → createRecord fields 含 LID（sync 阶段读取用）
  //   - job.securityId 有值时 → createRecord fields 含 SECURITY_ID（friend/add 鉴权）
  //   - job.lid/securityId 缺失时 → fields 不含这 2 个键（避免 undefined 写入飞书）
  //
  // 来源：SearchResultLite.lid + .securityId（来自 search-and-write.ts:39-41 类型定义）

  it('TEST 8: job.lid + job.securityId 有值时 → createRecord fields 含 LID + SECURITY_ID', async () => {
    // Arrange: jobA 带 lid + securityId, jobB 不带
    const JOB_A_WITH_LID_SID = {
      ...JOB_A,
      lid: 'Lxaxb11B6S.search.1',
      securityId: 'esknqGib9UMBo-O1E14211s0Gf2Ocd_Z...',
    } as unknown as Job
    const deps = {
      searchJobs: vi.fn(async () => [JOB_A_WITH_LID_SID, JOB_B]),
      fetchJobDetail: vi.fn(async (jobId: string) =>
        jobId === 'jobA_encryptedId' ? 'JD for A' : 'JD for B',
      ),
      scoreJob: vi.fn(async () => makeMockScoreResult(0.92)), // 都通过
      createRecord: vi.fn(async () => ({ record_id: 'rec_new' })),
      resolveResume: vi.fn(async () => ({ summary: SAMPLE_RESUME, source: 'yaml' as const, warnings: [] })),
      llm: {} as unknown,
      threshold: 0.85,
    }

    // Act
    await runSearchAndWrite(
      { keyword: '前端', city: '杭州', write: true, dryRun: false, noThreshold: false, limit: 10 },
      deps,
    )

    // Assert: 2 个 createRecord call
    expect(deps.createRecord).toHaveBeenCalledTimes(2)

    // jobA 应该同时有 LID + SECURITY_ID
    const jobACall = (deps.createRecord as any).mock.calls.find(
      (c: any[]) => c[0].BOSS_ID === 'jobA_encryptedId',
    )
    expect(jobACall).toBeDefined()
    expect(jobACall[0].LID).toBe('Lxaxb11B6S.search.1')
    expect(jobACall[0].SECURITY_ID).toBe('esknqGib9UMBo-O1E14211s0Gf2Ocd_Z...')

    // jobB 不带 lid/securityId → fields 中不应有 LID/SECURITY_ID 键
    const jobBCall = (deps.createRecord as any).mock.calls.find(
      (c: any[]) => c[0].BOSS_ID === 'jobB_encryptedId',
    )
    expect(jobBCall).toBeDefined()
    expect('LID' in jobBCall[0]).toBe(false)
    expect('SECURITY_ID' in jobBCall[0]).toBe(false)
  })

  // ----------------------------------------------------------
  // TEST 9: Sprint E-3.2a — passingJobs[] 返回值 (auto-handler.bossSearch 直接消费)
  // ----------------------------------------------------------
  // 行为契约 (Sprint E-3.2a §17.17.1):
  //   - 通过阈值 (≥ threshold) 且 createRecord 成功的 job → passingJobs[] 元素
  //   - 每个元素: { jobId, lid?, securityId?, title, recordId, score }
  //   - dryRun=true → recordId = 'dry-run-noop'
  //   - createRecord 抛错时 → 该 job 跳过 (failed++, 但不污染 passingJobs)

  it('TEST 9: passingJobs[] 含 recordId/lid/securityId/title/score（auto bossSearch 透传）', async () => {
    // Arrange: 1 job 全字段, createRecord 返真 record_id
    const FULL_JOB = {
      ...JOB_A,
      lid: 'Lxaxb11B6S.search.2',
      securityId: 'esknqGib9UMBo-O2E14211s0Gf2Ocd_Z...',
    } as unknown as Job
    const deps = {
      searchJobs: vi.fn(async () => [FULL_JOB]),
      fetchJobDetail: vi.fn(async () => 'JD for full'),
      scoreJob: vi.fn(async () => makeMockScoreResult(0.92)),
      createRecord: vi.fn(async () => ({ record_id: 'rec_real_001' })),
      resolveResume: vi.fn(async () => ({ summary: SAMPLE_RESUME, source: 'yaml' as const, warnings: [] })),
      llm: {} as unknown,
      threshold: 0.85,
    }

    // Act (write mode = 真写飞书)
    const result = await runSearchAndWrite(
      { keyword: '前端', city: '杭州', write: true, dryRun: false, noThreshold: false, limit: 10 },
      deps,
    )

    // Assert
    expect(result.action).toBe('ok')
    if (result.action !== 'ok') throw new Error('result is not ok')

    expect(result.passingJobs).toHaveLength(1)
    expect(result.passingJobs[0]).toEqual({
      jobId: 'jobA_encryptedId',
      lid: 'Lxaxb11B6S.search.2',
      securityId: 'esknqGib9UMBo-O2E14211s0Gf2Ocd_Z...',
      title: '高级前端工程师',
      recordId: 'rec_real_001',
      score: 0.92,
    })
  })

  it('TEST 9-b: dryRun=true 时 recordId = "dry-run-noop"（per cli/index.ts:289 一致）', async () => {
    const deps = {
      searchJobs: vi.fn(async () => [JOB_A]),
      fetchJobDetail: vi.fn(async () => 'JD for A'),
      scoreJob: vi.fn(async () => makeMockScoreResult(0.92)),
      createRecord: vi.fn(async () => ({ record_id: 'should-not-be-called' })),
      resolveResume: vi.fn(async () => ({ summary: SAMPLE_RESUME, source: 'yaml' as const, warnings: [] })),
      llm: {} as unknown,
      threshold: 0.85,
    }

    // Act (write:false + dryRun:true → runSearchAndWrite 走 noop createRecord)
    // 关键: passingJobs 仍要收集 (auto-handler 即使 dryRun 也会收到 jobs 列表)
    const result = await runSearchAndWrite(
      { keyword: '前端', city: '杭州', write: false, dryRun: true, noThreshold: false, limit: 10 },
      deps,
    )

    // Assert: createRecord 不调 (write:false)
    expect(deps.createRecord).not.toHaveBeenCalled()

    // passingJobs 仍 1 个, 但 recordId='dry-run-noop'
    expect(result.action).toBe('ok')
    if (result.action !== 'ok') throw new Error('result is not ok')
    expect(result.passingJobs).toHaveLength(1)
    expect(result.passingJobs[0].recordId).toBe('dry-run-noop')
    expect(result.passingJobs[0].score).toBe(0.92)
  })

  it('TEST 9-c: 没通过阈值的 job → 不出现在 passingJobs（threshold 过滤）', async () => {
    const deps = {
      searchJobs: vi.fn(async () => [JOB_A, JOB_B]),
      fetchJobDetail: vi.fn(async () => 'JD'),
      scoreJob: vi.fn(async () => makeMockScoreResult(0.5)),  // 低于 0.85 阈值
      createRecord: vi.fn(async () => ({ record_id: 'never' })),
      resolveResume: vi.fn(async () => ({ summary: SAMPLE_RESUME, source: 'yaml' as const, warnings: [] })),
      llm: {} as unknown,
      threshold: 0.85,
    }

    const result = await runSearchAndWrite(
      { keyword: '前端', city: '杭州', write: true, dryRun: false, noThreshold: false, limit: 10 },
      deps,
    )

    expect(result.action).toBe('ok')
    if (result.action !== 'ok') throw new Error('result is not ok')
    expect(result.passed).toBe(0)
    expect(result.passingJobs).toHaveLength(0)
    expect(deps.createRecord).not.toHaveBeenCalled()
  })
})
