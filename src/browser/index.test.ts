// ============================================================
// src/browser/index.ts TDD
// ============================================================
// P1 guard backlog #7: sendGreeting 的内层 try/catch 把 GuardError
// 吞掉返回 false，CLI 用户看不到风控决策原因。
//
// 修复方案：try/catch 应该 catch 业务错误并返回 false，
// 但 instanceof GuardError 时 rethrow，让决策透明给调用方。
//
// 关键设计：测试要让 page.goto 在 fn 内部抛 GuardError（绕过
// withGuard probe 阶段），验证 sendGreeting 不应吞这个 GuardError。
// ============================================================

import { describe, it, expect, vi } from 'vitest'
import { sendGreeting, fetchJobDetail } from './index.js'
import { GuardError, type GuardDecision } from './guard.js'

// ------------------------------------------------------------
// helper：构造 mock page（probe 不命中，所有 selector 返 null）
// ------------------------------------------------------------
function makeMockPage() {
  return {
    goto: vi.fn().mockResolvedValue(undefined),
    waitForSelector: vi.fn().mockResolvedValue(undefined),
    $eval: vi.fn().mockResolvedValue(''),
    $: vi.fn().mockResolvedValue(null), // probe 不命中任何 selector
    click: vi.fn().mockResolvedValue(undefined),
    // wapi 调用默认返 ok=false（jobDesc 缺失），触发降级到 page.goto
    evaluate: vi.fn().mockResolvedValue({ ok: false, error: 'jobDesc 字段缺失或为空' }),
    mouse: { move: vi.fn().mockResolvedValue(undefined) },
    focus: vi.fn().mockResolvedValue(undefined),
    keyboard: {
      press: vi.fn().mockResolvedValue(undefined),
      type: vi.fn().mockResolvedValue(undefined),
    },
  }
}

const FAST_TYPE_OPTS = {
  minDelayMs: 1,
  maxDelayMs: 2,
  typoRate: 0,
  pauseChance: 0,
}

// ============================================================
// sendGreeting 决策透明性（backlog #7）
// ============================================================

describe('sendGreeting × GuardError', () => {
  it('业务错误（page.goto 抛 PageError）：catches and returns false', async () => {
    const page = makeMockPage()
    page.goto = vi.fn().mockRejectedValue(new Error('navigation timeout'))

    const result = await sendGreeting(page as any, 'JOB123', 'hello', FAST_TYPE_OPTS)
    expect(result).toBe(false)
  })

  it('【RED】GuardError 来自 fn 内（page.goto）：必须 throw（不被吞）', async () => {
    // 关键：把 GuardError 抛在 fn 内（page.goto 阶段），绕过 withGuard probe
    // 当前实现：catch (err) { ... return false } 会吞掉 GuardError
    // 修复后：catch 内 instanceof GuardError 应该 rethrow
    const decision: GuardDecision = {
      action: 'abort_today',
      reason: '登录已失效',
      signal: {
        type: 'login_expired',
        confidence: 1,
        rawSelector: '.session-timeout-modal',
        detectedAt: new Date(),
      },
    }
    const page = makeMockPage()
    page.goto = vi.fn().mockImplementation(async () => {
      throw new GuardError(decision)
    })

    await expect(
      sendGreeting(page as any, 'JOB123', 'hello', FAST_TYPE_OPTS),
    ).rejects.toBeInstanceOf(GuardError)
  })

  it('正常路径：page 一切顺利返回 true', async () => {
    const page = makeMockPage()

    const result = await sendGreeting(page as any, 'JOB123', 'hi', FAST_TYPE_OPTS)
    expect(result).toBe(true)
  })
})

// ============================================================
// fetchJobDetail — fallback selector 链（2026-07-07 修 P0）
// ============================================================
// 行为契约：
//   - 构造正确的 BOSS 岗位 URL（https://www.zhipin.com/job_detail/{jobId}.html）
//   - 优先尝试主选择器（.job-sec-text），失败时按顺序试 fallback
//   - 每个选择器独立超时（不串行等待）
//   - 返回首个非空文本
//   - 所有选择器都失败 → 抛带 URL + 尝试列表的详细错误
//
// 为什么需要 fallback：
//   BOSS 前端 HTML 经常改 class 名，硬编码单一选择器 100% 会挂
//   （2026-07-07 dry-run 暴露：.job-sec-text 失效）
// ============================================================

describe('fetchJobDetail — fallback selector 链', () => {
  it('主选择器命中：返回 .job-sec-text 的文本', async () => {
    const page = makeMockPage()
    page.waitForSelector = vi.fn().mockResolvedValue(undefined)
    page.$eval = vi.fn().mockResolvedValue('主选择器拿到的 JD')

    const jd = await fetchJobDetail(page as any, 'JOB123')

    expect(jd).toBe('主选择器拿到的 JD')
    expect(page.goto).toHaveBeenCalledWith(
      'https://www.zhipin.com/job_detail/JOB123.html',
      expect.objectContaining({ waitUntil: 'domcontentloaded' }),
    )
  })

  it('🚨 关键：主选择器超时，fallback 选择器命中 → 返回 fallback 文本', async () => {
    const page = makeMockPage()
    // 第一次 waitForSelector 抛 timeout，第二次成功
    page.waitForSelector = vi
      .fn()
      .mockRejectedValueOnce(new Error('Timeout 3000ms exceeded'))
      .mockResolvedValueOnce(undefined)
    // $eval 只在最后那个 selector 被调用时返回文本
    page.$eval = vi.fn().mockImplementation(async (selector: string) => {
      if (selector === '.job-sec-text') throw new Error('主选择器拿不到')
      return 'fallback 拿到的 JD 内容'
    })

    const jd = await fetchJobDetail(page as any, 'JOB456')

    expect(jd).toBe('fallback 拿到的 JD 内容')
    // waitForSelector 至少被调用 2 次（主 + 至少 1 个 fallback）
    expect(page.waitForSelector).toHaveBeenCalledTimes(2)
  })

  it('主选择器返空文本时，继续尝试 fallback（不返空串当成功）', async () => {
    const page = makeMockPage()
    page.waitForSelector = vi.fn().mockResolvedValue(undefined)
    // 主选择器命中但内容为空，fallback 命中且有内容
    page.$eval = vi.fn().mockImplementation(async (selector: string) => {
      if (selector === '.job-sec-text') return ''
      return '真正有内容的 JD'
    })

    const jd = await fetchJobDetail(page as any, 'JOB789')

    expect(jd).toBe('真正有内容的 JD')
  })

  it('🚨 所有选择器都失败：抛带 URL + 尝试列表的详细错误', async () => {
    const page = makeMockPage()
    page.waitForSelector = vi.fn().mockRejectedValue(new Error('Timeout'))
    page.$eval = vi.fn().mockRejectedValue(new Error('not found'))

    // 传 throttleMs: 0 跳过限速 sleep（生产 3000ms 限速是为了反爬）
    await expect(fetchJobDetail(page as any, 'BAD_JOB', { throttleMs: 0 })).rejects.toThrow(
      /job_detail\/BAD_JOB\.html/,
    )
    // 验证错误消息包含尝试过的选择器列表（让用户能立刻定位是哪个 selector 失效）
    await expect(fetchJobDetail(page as any, 'BAD_JOB', { throttleMs: 0 })).rejects.toThrow(
      /\.job-sec-text.*job-detail-section/s,
    )
  })

  it('page.goto 抛错（无网络/404）：直接抛错，不尝试任何选择器', async () => {
    const page = makeMockPage()
    page.goto = vi.fn().mockRejectedValue(new Error('net::ERR_NAME_NOT_RESOLVED'))

    await expect(fetchJobDetail(page as any, 'X')).rejects.toThrow(/ERR_NAME_NOT_RESOLVED/)
    expect(page.waitForSelector).not.toHaveBeenCalled()
  })
})
