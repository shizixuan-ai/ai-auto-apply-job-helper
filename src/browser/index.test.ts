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
import { sendGreeting } from './index.js'
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
    evaluate: vi.fn().mockResolvedValue({ code: 0, zpData: { jobList: [] } }),
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
