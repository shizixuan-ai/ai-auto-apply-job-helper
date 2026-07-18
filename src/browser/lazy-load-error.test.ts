// ============================================================
// src/browser/lazy-load-error.ts TDD
// ------------------------------------------------------------
// ADR-0004 决策 2：抽离 LazyLoadError + DEFAULT_MIN_JD_LENGTH 后，
// 验证 class 行为 + env override 隔离（避免污染其他测试）。
//
// 关键设计：
//   - env override 块必须 FIRST：DEFAULT_MIN_JD_LENGTH 是 module-level 求值
//   - vi.resetModules() + 动态 import 强制重新求值
// ============================================================

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'

describe('LazyLoadError — DEFAULT_MIN_JD_LENGTH env override (FIRST)', () => {
  beforeAll(() => {
    vi.resetModules()
    vi.stubEnv('MIN_JD_LENGTH_THRESHOLD', '800')
  })

  afterAll(() => {
    vi.unstubAllEnvs()
    delete process.env.MIN_JD_LENGTH_THRESHOLD
    vi.resetModules()
  })

  it('TEST 5: env override MIN_JD_LENGTH_THRESHOLD=800 -> DEFAULT_MIN_JD_LENGTH=800', async () => {
    const mod = await import('./lazy-load-error.js')
    expect(mod.DEFAULT_MIN_JD_LENGTH).toBe(800)
  })

  it('TEST 5b: LazyLoadError message contains overridden threshold 800', async () => {
    const { LazyLoadError } = await import('./lazy-load-error.js')
    const err = new LazyLoadError({
      url: 'https://www.zhipin.com/job_detail/X.html',
      selectors: ['.job-sec-text'],
      lengthHistory: { '.job-sec-text': [100] },
      cause: 'all_selectors_lazy',
    })
    expect(err.message).toContain('≥ 800')
  })
})

describe('LazyLoadError — class behavior (default 500)', () => {
  beforeAll(() => {
    vi.resetModules()
    delete process.env.MIN_JD_LENGTH_THRESHOLD
  })

  afterAll(() => {
    vi.resetModules()
  })

  it('TEST 4: default value === 500 (no env override)', async () => {
    const mod = await import('./lazy-load-error.js')
    expect(mod.DEFAULT_MIN_JD_LENGTH).toBe(500)
  })

  it('TEST 1: LazyLoadError.name === "LazyLoadError"', async () => {
    const { LazyLoadError } = await import('./lazy-load-error.js')
    const err = new LazyLoadError({
      url: 'https://www.zhipin.com/job_detail/X.html',
      selectors: ['.job-sec-text'],
      lengthHistory: { '.job-sec-text': [100, 200, 300] },
      cause: 'all_selectors_lazy',
    })
    expect(err.name).toBe('LazyLoadError')
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(LazyLoadError)
  })

  it('TEST 2: url/selectors/lengthHistory/cause fields accessible', async () => {
    const { LazyLoadError } = await import('./lazy-load-error.js')
    const url = 'https://www.zhipin.com/job_detail/ABC.html'
    const selectors = ['.job-sec-text', '.job-detail-section', '[class*="job-detail"]']
    const lengthHistory = {
      '.job-sec-text': [100, 200, 300],
      '.job-detail-section': [50, 80, 90],
      '[class*="job-detail"]': [10, 20, 30],
    }
    const err = new LazyLoadError({
      url,
      selectors,
      lengthHistory,
      cause: 'all_selectors_lazy',
    })

    expect(err.url).toBe(url)
    expect(err.selectors).toEqual(selectors)
    expect(err.lengthHistory).toEqual(lengthHistory)
    expect(err.cause).toBe('all_selectors_lazy')
  })

  it('TEST 3: message contains "LazyLoadError:" prefix + URL + cause + length history', async () => {
    const { LazyLoadError } = await import('./lazy-load-error.js')
    const err = new LazyLoadError({
      url: 'https://www.zhipin.com/job_detail/TEST.html',
      selectors: ['.job-sec-text'],
      lengthHistory: { '.job-sec-text': [100, 200, 300] },
      cause: 'all_selectors_lazy',
    })

    expect(err.message).toContain('LazyLoadError:')
    expect(err.message).toContain('https://www.zhipin.com/job_detail/TEST.html')
    expect(err.message).toContain('all_selectors_lazy')
    expect(err.message).toContain('.job-sec-text')
    expect(err.message).toContain('100, 200, 300')
  })
})