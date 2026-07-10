// ============================================================
// verify-jd-length.test.ts — Smoke Rule #4 (ADR-0004 decision 4)
// ============================================================
// 覆盖 parseLengths（纯字符串解析，无 spawn 副作用）
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest'

async function freshModule() {
  vi.resetModules()
  return await import('./verify-jd-length.mjs' as any)
}

beforeEach(() => {
  vi.restoreAllMocks()
})

// ============================================================
// TEST 1-4: parseLengths 单元测试
// ============================================================
describe('verify-jd-length — parseLengths', () => {
  it('TEST 1: textLength=500 → [500]', async () => {
    const { parseLengths } = await freshModule()
    const lengths = parseLengths('textLength=500\n')
    expect(lengths).toEqual([500])
  })

  it('TEST 2: textLength: 800, textLength=600 → [800, 600]', async () => {
    const { parseLengths } = await freshModule()
    const lengths = parseLengths('textLength: 800, textLength=600')
    expect(lengths).toEqual([800, 600])
  })

  it('TEST 3: 无匹配 → []', async () => {
    const { parseLengths } = await freshModule()
    expect(parseLengths('no match\n')).toEqual([])
  })

  it('TEST 4: textLength=300 → [300]（短 JD 也能解析，仅判定时 FAIL）', async () => {
    const { parseLengths } = await freshModule()
    const lengths = parseLengths('textLength=300')
    expect(lengths).toEqual([300])
  })

  it('TEST 5: 多行混合格式 → 按出现顺序', async () => {
    const { parseLengths } = await freshModule()
    const sample = `
📊 搜索并评分结果 (mode=DRY-RUN):
  job1: textLength=720 ✓
  job2: textLength: 1500 ✓
  job3: textLength=480 ⚠️
`
    expect(parseLengths(sample)).toEqual([720, 1500, 480])
  })
})