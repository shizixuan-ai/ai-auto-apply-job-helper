// ============================================================
// pickZhipinTabOrNew — TDD (2026-07-07 commit 4d0c287 audit fix)
// ============================================================
// 这个函数是 P0 commit `4d0c287` 中新加的逻辑，
// 决策：复用已打开的 zhipin tab 避免 BOSS 因 Referer 缺失静默拒服务。
//
// 抽出为独立函数（不内联在 createCDPSession）是为了 unit test，
// 否则要 mock 整个 connectToUserChrome + attachPlaywrightToCDP 链路。
//
// 关键安全属性：必须真的从 pages().find(...) 里挑出 zhipin tab
//   而非无脑 newPage —— 否则 BOSS 防爬会断我们的链路。
// ============================================================

import { describe, it, expect, vi } from 'vitest'
import { pickZhipinTabOrNew } from './index.js'

type MockPage = { url: () => string | undefined }

function makePage(url: string | undefined): MockPage {
  return { url: () => url }
}

function makeContext(pages: MockPage[], newPageFn: () => Promise<unknown> = async () => ({ id: 'NEW' })) {
  return {
    pages: vi.fn(() => pages),
    newPage: vi.fn(newPageFn),
  }
}

describe('pickZhipinTabOrNew — P0 audit fix', () => {
  it('已有 zhipin tab 时复用，不调 newPage', async () => {
    const zpTab = makePage('https://www.zhipin.com/job_detail/abc.html')
    const ctx = makeContext([makePage('about:blank'), zpTab, makePage('https://example.com')])

    const result = await pickZhipinTabOrNew(ctx as any)

    expect(result).toBe(zpTab)             // ✅ 真的复用，不是新建
    expect(ctx.newPage).not.toHaveBeenCalled()
  })

  it('URL 含 zhipin.com 子域也算（如杭州站 hangzhou.zhipin.com）', async () => {
    const zpTab = makePage('https://hangzhou.zhipin.com/?ka=seo')
    const ctx = makeContext([makePage('about:blank'), zpTab])

    const result = await pickZhipinTabOrNew(ctx as any)

    expect(result).toBe(zpTab)
    expect(ctx.newPage).not.toHaveBeenCalled()
  })

  it('没有 zhipin tab 时 fallback 到 newPage（保留 steal 路径）', async () => {
    const ctx = makeContext([makePage('about:blank'), makePage('https://example.com')])

    const result = await pickZhipinTabOrNew(ctx as any)

    expect(result).toEqual({ id: 'NEW' })
    expect(ctx.newPage).toHaveBeenCalledTimes(1)
  })

  it('空 context 也跑（不抛错）', async () => {
    const ctx = makeContext([])

    const result = await pickZhipinTabOrNew(ctx as any)

    expect(ctx.newPage).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ id: 'NEW' })
  })

  it('zhipin tab url 是 undefined 时不被误判成 zhipin', async () => {
    // 防御：page.url() 偶发返回 undefined
    const safeToIncludeUndef = makePage('about:blank')
    const contextWithoutUrl = makePage(undefined as unknown as string)
    const ctx = makeContext([safeToIncludeUndef, contextWithoutUrl])

    const result = await pickZhipinTabOrNew(ctx as any)

    // 不应该匹配 undefined (否则会拿到一个不能 goto 的 page 报错)
    expect(result).not.toBe(contextWithoutUrl)
    expect(ctx.newPage).toHaveBeenCalledTimes(1)
  })

  it('about:blank 不是 zhipin tab（不应误复用）', async () => {
    const ctx = makeContext([makePage('about:blank')])

    const result = await pickZhipinTabOrNew(ctx as any)

    expect(result).not.toBe(ctx.pages()[0])
    expect(ctx.newPage).toHaveBeenCalledTimes(1)
  })
})
