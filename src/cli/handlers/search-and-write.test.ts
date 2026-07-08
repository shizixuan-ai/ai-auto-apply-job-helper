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
import type { Job } from '../../types/index.js'

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
  education: '本科',
  skills: ['TypeScript', 'React'],
  recentProjects: [],
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
        return 0.92 // jobB 通过
      }),
      createRecord: vi.fn(async () => ({ record_id: 'rec_new' })),
      resolveResume: vi.fn(async () => ({ summary: SAMPLE_RESUME, source: 'md' as const, warnings: [] })),
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
  })
})
