// ============================================================
// robustEvaluate — Sprint 2026-07-13 / ADR-0005
// ============================================================
// 包裹 page.evaluate，捕获 BOSS SPA client-side hydration 引发的
// "Execution context was destroyed" / "Navigating away" 等 race 错误，
// 等 DOM 稳定 + 退避 N 次重试。
//
// 关键设计：
//   - 仅对 navigation 类错误重试（避免掩盖业务 bug）
//   - 重试上限 DEFAULT_RETRIES = 2（首次 + 2 次 = 3 次）
//   - 退避 RETRY_DELAY_MS = 500（vi.useFakeTimers() 可控）
//   - waitForLoadState('domcontentloaded') 兜底（部分 race 不会触发任何 load 事件）
// ============================================================

import type { Page } from 'playwright'

/** 默认重试次数（首次失败后再重试 2 次） */
const DEFAULT_RETRIES = 2

/** 重试前退避时间（ms） */
const RETRY_DELAY_MS = 500

/** Playwright 抛"navigation race"错误的关键词（多种语言字符串都覆盖） */
const NAV_KEYWORDS = [
  'context was destroyed',
  'navigating away',
  'target page, context or browser has been closed',
  'navigation interrupted',
]

/**
 * 错误是否是 navigation race 类型
 * - true → robustEvaluate 会等 + 重试
 * - false → robustEvaluate 立即重抛（不掩盖业务错误）
 */
export function isNavigationError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const msg = err.message || ''
  return NAV_KEYWORDS.some((kw) => msg.toLowerCase().includes(kw))
}

/**
 * Robust wrapper over page.evaluate
 *
 * @param page  Playwright Page（含 evaluate + 可选 waitForLoadState）
 * @param fn    要在浏览器上下文执行的函数
 * @param arg   传给 fn 的参数（只能有 1 个 —— Playwright 限制）
 * @param retries 重试次数（不含首次；默认 2）
 */
export async function robustEvaluate<T>(
  page: Pick<Page, 'evaluate'> & { waitForLoadState?: (state: string) => Promise<unknown> },
  fn: (...args: unknown[]) => Promise<T> | T,
  arg?: unknown,
  retries: number = DEFAULT_RETRIES,
): Promise<T> {
  let lastErr: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await page.evaluate(fn, arg as never)
    } catch (err) {
      lastErr = err
      if (!isNavigationError(err)) throw err
      if (attempt === retries) break
      try {
        await page.waitForLoadState?.('domcontentloaded')
      } catch {
        // ignore waitForLoadState 自己的 reject（如 race 仍未结束时）
      }
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS))
    }
  }
  throw lastErr
}
