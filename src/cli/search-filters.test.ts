import { describe, it, expect } from 'vitest'
import { buildSearchFilters } from './search-filters.js'

// ============================================================
// buildSearchFilters — CLI options → SearchFilters 映射
// ------------------------------------------------------------
// DEEP probe 2026-07-18：BOSS 接受 jobType/salary/experience/degree
//   为 string 顶层字段。CLI flag（--job-type 等）值原样透传为 BOSS 码。
// 约束：全空 → 返回 undefined（让 searchJobs 调用与无 filter 时逐字节一致）
// ============================================================
describe('buildSearchFilters', () => {
  it('全部传值 → 映射为 SearchFilters（string 原样）', () => {
    const f = buildSearchFilters({
      jobType: '1901',
      salary: '406',
      experience: '106',
      degree: '203',
    })
    expect(f).toEqual({
      jobType: '1901',
      salary: '406',
      experience: '106',
      degree: '203',
    })
  })

  it('全空（无 flag）→ 返回 undefined（回归安全，调用点与旧行为一致）', () => {
    expect(buildSearchFilters({})).toBeUndefined()
    expect(buildSearchFilters({ jobType: '', salary: undefined })).toBeUndefined()
  })

  it('部分传值 → 只含有值的字段，空值/undefined 省略', () => {
    const f = buildSearchFilters({ salary: '406', jobType: '', degree: undefined })
    expect(f).toEqual({ salary: '406' })
    expect(f).not.toHaveProperty('jobType')
    expect(f).not.toHaveProperty('degree')
  })
})
