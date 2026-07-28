// ============================================================
// searchJobs fallback 错误边界单测 — §3.9 错误传播
// ============================================================
// 背景（Debug Gate 2026-07-23）：
//   BOSS 反爬把 API 主路径打穿（page.evaluate 执行上下文被导航摧毁）
//   → 降级到纯 DOM fallback → fallback 的 page.goto 又吃 ERR_CONNECTION_CLOSED
//   → 原始 Playwright 错误裸奔逃出 searchJobs → CLI 顶层 program.parse() 无兜底
//   → Node uncaught rejection 崩溃。
//
//   潜伏 bug：browser/index.ts 从创建 commit(806a7d9, 2026-06-30)起
//   fallback page.goto 就没有 try/catch。之前 API 主路径一直成功，走不到
//   fallback，所以没暴露。BOSS 反爬升级后第一次真正踩到 → 当场炸。
//
// 本测试锁定 A1：fallback page.goto 抛错时，searchJobs 必须转成
//   「可操作的领域错误」（提到反爬 + 给出建议），不泄露原始 ERR_CONNECTION_CLOSED
//   作为唯一信息（§3.9：每个 throw 必须有 catch 边界，降级路径不许假象安全）。
// ============================================================

import { describe, it, expect } from 'vitest'
import { searchJobs } from '../../src/browser/index.js'

/**
 * 构造最小 fake Playwright page，精确覆盖 searchJobs 走 fallback-crash 分支所需方法：
 *   - url()：返 /web/geek/job → alreadyOnBoss=true → 跳过入口 goto（只留 fallback goto）
 *   - context().cookies()：含 zp_at → hasAuthToken 通过（不在登录失效分支提前退出）
 *   - evaluate()：返 {error} → 模拟风控摧毁执行上下文 → fetchPageJson 页级失败 → break → 空 rawJobList → fallback
 *   - goto()：抛 ERR_CONNECTION_CLOSED → 模拟 BOSS 掐连接
 */
function makeFakePage(): any {
  return {
    url: () => 'https://www.zhipin.com/web/geek/job?query=Java',
    context: () => ({
      cookies: async () => [{ name: 'zp_at', domain: '.zhipin.com' }],
    }),
    evaluate: async () => ({
      error: 'page.evaluate threw: Execution context was destroyed, most likely because of a navigation.',
    }),
    goto: async () => {
      throw new Error(
        'page.goto: net::ERR_CONNECTION_CLOSED at https://www.zhipin.com/web/geek/job?query=Java',
      )
    },
  }
}

describe('searchJobs fallback 错误边界 (§3.9)', () => {
  it('API 被反爬打穿 + fallback goto 连接被关 → 抛可操作的领域错误（提到反爬 + 建议）', async () => {
    let caught: any
    try {
      await searchJobs(makeFakePage(), 'Java', undefined, undefined, {
        maxResults: 5,
        pageThrottleMs: 0,
      })
    } catch (e) {
      caught = e
    }

    expect(caught).toBeInstanceOf(Error)
    // 领域框架：明确告诉用户是反爬/风控，而非裸奔的 net:: 错误码
    expect(caught.message).toMatch(/反爬|风控/)
    // 可操作建议：给出下一步（重试 / 换网络 IP / 降频）
    expect(caught.message).toMatch(/重试|IP|网络|稍后/)
  })
})
