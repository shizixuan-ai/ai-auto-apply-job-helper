// ============================================================
// src/browser/robust-evaluate.ts TDD — RED phase (Sprint 2026-07-13)
// ============================================================
// ADR-0005 决策：page.evaluate wrapper 捕获"navigation race"错误，
// 等待 + 重试，撑过 BOSS SPA client-side hydration。
//
// 关键行为契约：
//   1) page.evaluate 一次成功 → 直接返回，不重试
//   2) 首次抛 navigation 类错误（context destroyed / navigating away），
//      等待 + 重试，第二次成功 → 返回第二次结果
//   3) 重试用尽 → 抛最后一次的错误
//   4) 非 navigation 错误（如 GuardError）→ 立即抛（不掩盖）
//
// 测试策略：
//   - 用 vi.useFakeTimers() 控 setTimeout，避免真 sleep 拖慢测试
//   - 动态 import 模块 —— RED 应断言失败（非 import 失败）
//   - 动态导入函数：避免顶层 TypeScript hoist + 让断言真的红
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/** 动态加载实现 —— 模块不存在时让断言失败（而非 import 报错） */
async function loadMod(): Promise<any> {
  // vitest 会捕获 module-not-found 错误，让我们在断言里 catch
  try {
    return await import('./robust-evaluate.js')
  } catch (err) {
    return null
  }
}

describe('robustEvaluate — Sprint 2026-07-13 RED', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('RED gate: 模块 ./robust-evaluate.js 必须存在且导出 robustEvaluate/isNavigationError', async () => {
    const mod = await loadMod()
    expect(mod, '模块需存在').not.toBeNull()
    expect(typeof mod.robustEvaluate).toBe('function')
    expect(typeof mod.isNavigationError).toBe('function')
  })

  it('case 1: 首次 page.evaluate 成功 → 返回值直传，page.evaluate 调 1 次', async () => {
    const { robustEvaluate } = await loadMod()
    const page = {
      evaluate: vi.fn().mockResolvedValue(42),
      waitForLoadState: vi.fn().mockResolvedValue(undefined),
    }

    const result = await robustEvaluate(page as any, async () => 42, undefined)

    expect(result).toBe(42)
    expect(page.evaluate).toHaveBeenCalledTimes(1)
    expect(page.waitForLoadState).not.toHaveBeenCalled()
  })

  it('case 2: 首次抛 navigation 错 + 第二次成功 → 返回第二次结果，等待后 page.evaluate 调 2 次', async () => {
    const { robustEvaluate } = await loadMod()
    const navErr = new Error(
      'Execution context was destroyed, most likely because of a navigation',
    )
    const page = {
      evaluate: vi
        .fn()
        .mockRejectedValueOnce(navErr)
        .mockResolvedValueOnce({ ok: true, jd: '第二次成功' }),
      waitForLoadState: vi.fn().mockResolvedValue(undefined),
    }

    const p = robustEvaluate(page as any, async () => '占位', undefined)
    await vi.runAllTimersAsync()
    const result = await p

    expect(result).toEqual({ ok: true, jd: '第二次成功' })
    expect(page.evaluate).toHaveBeenCalledTimes(2)
    expect(page.waitForLoadState).toHaveBeenCalledWith('domcontentloaded')
  })

  it('case 3: 连续 N+1 次都抛 navigation 错 → 抛最后一次错', async () => {
    const { robustEvaluate } = await loadMod()
    const navErr = (msg: string) => new Error(msg + ': Execution context was destroyed')
    const page = {
      evaluate: vi
        .fn()
        .mockRejectedValueOnce(navErr('attempt1'))
        .mockRejectedValueOnce(navErr('attempt2'))
        .mockRejectedValueOnce(navErr('attempt3')),
      waitForLoadState: vi.fn().mockResolvedValue(undefined),
    }

    const p = robustEvaluate(page as any, async () => 1, undefined, /* retries */ 2)
    await vi.runAllTimersAsync()

    await expect(p).rejects.toThrow(/attempt3/)
    expect(page.evaluate).toHaveBeenCalledTimes(3)
    expect(page.waitForLoadState).toHaveBeenCalledTimes(2)
  })

  it('case 4: 非 navigation 错误 → 立刻抛，不重试', async () => {
    const { robustEvaluate } = await loadMod()
    const businessErr = new Error('business logic failed: postDescription 字段缺失或为空')
    const page = {
      evaluate: vi.fn().mockRejectedValue(businessErr),
      waitForLoadState: vi.fn().mockResolvedValue(undefined),
    }

    await expect(
      robustEvaluate(page as any, async () => 1, undefined),
    ).rejects.toThrow(/postDescription 字段缺失或为空/)

    expect(page.evaluate).toHaveBeenCalledTimes(1)
    expect(page.waitForLoadState).not.toHaveBeenCalled()
  })
})

describe('isNavigationError — 分类函数', () => {
  it('RED gate: isNavigationError 必须存在', async () => {
    const mod = await loadMod()
    expect(typeof mod.isNavigationError).toBe('function')
  })

  it('命中 "Execution context was destroyed" → true', async () => {
    const { isNavigationError } = await loadMod()
    expect(isNavigationError(new Error('Execution context was destroyed'))).toBe(true)
  })

  it('命中 "navigating away" → true', async () => {
    const { isNavigationError } = await loadMod()
    expect(isNavigationError(new Error('Navigating away from this page'))).toBe(true)
  })

  it('业务错误（含中文） → false', async () => {
    const { isNavigationError } = await loadMod()
    expect(isNavigationError(new Error('postDescription 字段缺失或为空'))).toBe(false)
  })

  it('太早期的 "Too many arguments" → false（明确不重试，让用户能看到原始 bug）', async () => {
    const { isNavigationError } = await loadMod()
    expect(isNavigationError(new Error('Too many arguments. If you need to pass more than 1 argument to the function wrap them in an object.'))).toBe(false)
  })

  it('undefined / 非 Error → false', async () => {
    const { isNavigationError } = await loadMod()
    expect(isNavigationError(undefined)).toBe(false)
    expect(isNavigationError('string err')).toBe(false)
  })
})
