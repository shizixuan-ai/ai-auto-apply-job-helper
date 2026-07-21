// ============================================================
// loginByQR — RED 测试（fake-green 修复）
// ============================================================
// Bug：原代码 L308-310 仅检查 URL（含 zhipin 且不含 /user/）就 return "已登录"。
//   实测发现 BOSS 服务端 session 短期缓存 + 服务端临时追踪 cookie（无 __zp_stoken__）
//   就能让首屏跳到非 /user/ 路径 → URL 检查误判 → 立即关浏览器，根本不进 QR 等待。
//
// 修复预期：URL 检查 AND cookies 必含 __zp_stoken__（或 zp_at）才能 return。
//   缺一：继续 QR 等待循环，让 user 扫码。
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { loginByQR } from './index.js'

// ============================================================
// mock page
// ============================================================

function makePage(opts: {
  urlAfterFirstGoto: string
  urlAfterSecondGoto: string
  cookies: Array<{ name: string; value: string; domain: string }>
}) {
  let gotoCount = 0
  return {
    goto: vi.fn(async (_url: string) => {
      gotoCount++
    }),
    url: vi.fn(() => {
      if (gotoCount === 0) return 'about:blank'
      if (gotoCount === 1) return opts.urlAfterFirstGoto
      return opts.urlAfterSecondGoto
    }),
    context: () => ({
      cookies: vi.fn(async () => opts.cookies),
    }),
  } as any
}

describe('loginByQR — fake-green 防御（首屏 URL 假登录）', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.useFakeTimers()
    // 必须在 loginByQR 之前 spy,否则 QR prompt 漏抓
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.useRealTimers()
    consoleSpy.mockRestore()
  })

  // ----------------------------------------------------------
  // BUG 路径：URL 不在 /user/ 但 cookie 无 __zp_stoken__ → 不应 return
  // ----------------------------------------------------------

  it('首屏 zhipin + 无 /user/ + cookie 无 __zp_stoken__ → 打印 QR 提示,不打印 "Cookie 有效"', async () => {
    const page = makePage({
      // 首屏 URL 在 zhipin 不含 /user/(BOSS 服务端短期 session 缓存的假绿)
      urlAfterFirstGoto: 'https://www.zhipin.com/web/geek/job',
      // 第二次 goto 后跳到 QR 登录页(模拟正常 QR 等待状态)
      urlAfterSecondGoto: 'https://www.zhipin.com/web/user/?ka=header-login',
      // cookie 是服务端临时追踪 cookie(无 __zp_stoken__/zp_at)
      cookies: [
        { name: '__c', value: '178461****', domain: '.zhipin.com' },
        { name: 'lastCity', value: '101210100', domain: '.zhipin.com' },
      ],
    })

    // 启动 loginByQR(不 await,让它在 timer 里跑)
    const promise = loginByQR(page)

    // 让首屏 goto + isLoggedIn 检查 + QR prompt 打印都完成
    // (都在第一个 setTimeout 之前,同步+微任务即可完成)
    await vi.advanceTimersByTimeAsync(0)
    // 让 while 循环跑一个 1s tick(在 /user/ 页,isLoggedIn=false,继续等)
    await vi.advanceTimersByTimeAsync(1100)

    const cookieValidPrinted = consoleSpy.mock.calls.some(
      (args: unknown[]) => typeof args[0] === 'string' && args[0].includes('Cookie 有效'),
    )
    expect(cookieValidPrinted).toBe(false) // 关键:不应打印"已登录"

    const qrPromptPrinted = consoleSpy.mock.calls.some(
      (args: unknown[]) => typeof args[0] === 'string' && args[0].includes('扫描二维码'),
    )
    expect(qrPromptPrinted).toBe(true) // 关键:应打印 QR 提示

    // 清理:不让 promise 永远跑
    promise.catch(() => {})
  })

  // ----------------------------------------------------------
  // 正确路径：URL 在 zhipin + cookie 含 __zp_stoken__ → 立即 return
  // ----------------------------------------------------------

  it('首屏 zhipin + cookie 含 __zp_stoken__ → 立即 return 已登录', async () => {
    const page = makePage({
      urlAfterFirstGoto: 'https://www.zhipin.com/web/geek/job',
      urlAfterSecondGoto: 'https://www.zhipin.com/web/geek/job',
      cookies: [
        { name: '__zp_stoken__', value: 'e7b3gR****', domain: '.zhipin.com' },
        { name: 'zp_at', value: 'u-Kakd****', domain: '.zhipin.com' },
        { name: '__c', value: '178461****', domain: '.zhipin.com' },
      ],
    })

    await loginByQR(page)

    const cookieValidPrinted = consoleSpy.mock.calls.some(
      (args: unknown[]) => typeof args[0] === 'string' && args[0].includes('Cookie 有效'),
    )
    expect(cookieValidPrinted).toBe(true)

    // 断言:goto 只调了 1 次(没进 QR 路径)
    expect(page.goto).toHaveBeenCalledTimes(1)
  })

  // ----------------------------------------------------------
  // 正确路径：URL 在 zhipin + cookie 含 zp_at → 立即 return
  // ----------------------------------------------------------

  it('首屏 zhipin + cookie 含 zp_at → 立即 return 已登录', async () => {
    const page = makePage({
      urlAfterFirstGoto: 'https://www.zhipin.com/web/geek/job',
      urlAfterSecondGoto: 'https://www.zhipin.com/web/geek/job',
      cookies: [
        { name: 'zp_at', value: 'u-Kakd****', domain: '.zhipin.com' },
        { name: '__c', value: '178461****', domain: '.zhipin.com' },
      ],
    })

    await loginByQR(page)

    const cookieValidPrinted = consoleSpy.mock.calls.some(
      (args: unknown[]) => typeof args[0] === 'string' && args[0].includes('Cookie 有效'),
    )
    expect(cookieValidPrinted).toBe(true)
    expect(page.goto).toHaveBeenCalledTimes(1)
  })
})
