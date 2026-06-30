// ============================================================
// 风控降级中间件 — TDD 测试（RED 阶段）
// ============================================================
// 覆盖 4 类图 review 后整合的 16 个测试点：
//   - 类型安全（RiskSignal / GuardDecision / GuardError）
//   - 纯函数：evaluateSignal / aggregateSignals
//   - 探针：probeRiskSignals（page.$ + 兜底 dialogSelector）
//   - 高阶函数：withGuard（PAUSE→waitForSelector→retry / 超时降级 / ABORT_TODAY 直接抛）
//   - Notifier：OSNotifier（darwin/linux/降级 console）+ ConsoleNotifier
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  evaluateSignal,
  aggregateSignals,
  probeRiskSignals,
  withGuard,
  GuardError,
  OSNotifier,
  ConsoleNotifier,
  DEFAULT_GUARD_CONFIG,
  type SignalType,
  type RiskSignal,
  type GuardDecision,
} from './guard.js'

// Hoist mock for node:child_process BEFORE importing guard.ts
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: vi.fn(),
  }
})

// ------------------------------------------------------------
// Test helpers
// ------------------------------------------------------------

function makeSignal(type: SignalType, confidence = 1, rawSelector = '.test'): RiskSignal {
  return {
    type,
    confidence,
    rawSelector,
    detectedAt: new Date('2026-06-30T00:00:00Z'),
  }
}

function makeConfig(overrides: Partial<typeof DEFAULT_GUARD_CONFIG> = {}) {
  return {
    ...DEFAULT_GUARD_CONFIG,
    captchaSelectors: ['.captcha-a', '.captcha-b'],
    sliderSelectors: ['.slider-a'],
    rateLimitSelectors: ['.rate-a'],
    loginExpiredSelectors: ['.login-expired-a'],
    fallbackDialogSelector: '[role="dialog"]',
    ...overrides,
  }
}

// ------------------------------------------------------------
// #1  RiskSignal 构造 + 字段
// ------------------------------------------------------------

describe('RiskSignal', () => {
  it('constructs with type / confidence / rawSelector / detectedAt', () => {
    const sig = makeSignal('verify_captcha', 0.9, '.geetest_panel')
    expect(sig.type).toBe('verify_captcha')
    expect(sig.confidence).toBe(0.9)
    expect(sig.rawSelector).toBe('.geetest_panel')
    expect(sig.detectedAt).toBeInstanceOf(Date)
  })
})

// ------------------------------------------------------------
// #2-#6  evaluateSignal: 4 类信号 → 4 类动作
// ------------------------------------------------------------

describe('evaluateSignal', () => {
  it('captcha → PAUSE', () => {
    const sig = makeSignal('verify_captcha', 1, '.captcha-a')
    const decision = evaluateSignal(sig, makeConfig())
    expect(decision.action).toBe('pause')
    expect(decision.signal).toBe(sig)
    expect(decision.expiresAt).toBeDefined()
    expect(decision.reason).toContain('验证码')
  })

  it('slider → PAUSE', () => {
    const sig = makeSignal('verify_slider', 1, '.slider-a')
    const decision = evaluateSignal(sig, makeConfig())
    expect(decision.action).toBe('pause')
    expect(decision.expiresAt).toBeDefined()
  })

  it('rate_limit → ABORT_TODAY', () => {
    const sig = makeSignal('rate_limit', 1, '.rate-a')
    const decision = evaluateSignal(sig, makeConfig())
    expect(decision.action).toBe('abort_today')
    expect(decision.reason).toContain('上限')
  })

  it('login_expired → ABORT_TODAY + reason mentions 重新登录', () => {
    const sig = makeSignal('login_expired', 1, '.login-expired-a')
    const decision = evaluateSignal(sig, makeConfig())
    expect(decision.action).toBe('abort_today')
    expect(decision.reason).toContain('重新登录')
  })

  it('safe → CONTINUE', () => {
    const sig = makeSignal('safe', 1, '')
    const decision = evaluateSignal(sig, makeConfig())
    expect(decision.action).toBe('continue')
  })

  it('PAUSE decision carries expiresAt = now + maxPauseMs', () => {
    const sig = makeSignal('verify_captcha', 1, '.captcha-a')
    const config = makeConfig({ maxPauseMs: 60_000 })
    const before = Date.now()
    const decision = evaluateSignal(sig, config)
    const after = Date.now()
    expect(decision.expiresAt!.getTime()).toBeGreaterThanOrEqual(before + 60_000)
    expect(decision.expiresAt!.getTime()).toBeLessThanOrEqual(after + 60_000)
  })
})

// ------------------------------------------------------------
// #7  aggregateSignals: 多信号取最高优先级
// ------------------------------------------------------------

describe('aggregateSignals', () => {
  it('returns null for empty array', () => {
    expect(aggregateSignals([])).toBeNull()
  })

  it('returns highest-priority signal when multiple present', () => {
    // 优先级：pause > abort_today > abort > continue
    const sigs = [
      makeSignal('safe', 1),
      makeSignal('rate_limit', 1),
      makeSignal('verify_captcha', 1),
    ]
    const top = aggregateSignals(sigs)
    expect(top?.type).toBe('verify_captcha')
  })

  it('PAUSE > ABORT_TODAY when both present', () => {
    const sigs = [
      makeSignal('rate_limit', 1),
      makeSignal('verify_captcha', 1),
    ]
    const top = aggregateSignals(sigs)
    expect(top?.type).toBe('verify_captcha')
  })
})

// ------------------------------------------------------------
// #8-#10  OSNotifier: 跨平台 + 降级
// ------------------------------------------------------------

describe('OSNotifier', () => {
  let originalPlatform: NodeJS.Platform
  let spawnMock: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    originalPlatform = process.platform
    const cp = await import('node:child_process')
    spawnMock = cp.spawn as unknown as ReturnType<typeof vi.fn>
    spawnMock.mockReset()
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
    spawnMock.mockReset()
  })

  it('darwin → spawn osascript with display notification', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    spawnMock.mockImplementation((_cmd, _args) => ({
      on: (event: string, cb: (code: number) => void) => {
        if (event === 'exit') cb(0)
      },
    }))

    const notifier = new OSNotifier('darwin')
    await notifier.notify({
      action: 'pause',
      reason: '请过验证',
      signal: makeSignal('verify_captcha'),
    })

    expect(spawnMock).toHaveBeenCalledWith(
      'osascript',
      expect.arrayContaining(['-e', expect.stringContaining('display notification')]),
    )
  })

  it('linux → spawn notify-send', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    spawnMock.mockImplementation((_cmd, _args) => ({
      on: (event: string, cb: (code: number) => void) => {
        if (event === 'exit') cb(0)
      },
    }))

    const notifier = new OSNotifier('linux')
    await notifier.notify({
      action: 'pause',
      reason: 'NOTIFY_PROBE_MSG',
      signal: makeSignal('verify_captcha'),
    })

    expect(spawnMock).toHaveBeenCalledWith(
      'notify-send',
      expect.arrayContaining(['NOTIFY_PROBE_MSG']),
    )
  })

  it('falls back to console when spawn fails', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    spawnMock.mockReturnValue({
      on: (event: string, cb: (code: number) => void) => {
        if (event === 'exit') cb(1)
      },
    })

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const notifier = new OSNotifier('darwin')
    await notifier.notify({
      action: 'pause',
      reason: 'FALLBACK_MSG',
      signal: makeSignal('verify_captcha'),
    })

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('FALLBACK_MSG'))
    logSpy.mockRestore()
  })
})

describe('ConsoleNotifier', () => {
  it('logs decision reason to console', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const notifier = new ConsoleNotifier()
    await notifier.notify({
      action: 'pause',
      reason: 'CONSOLE_PROBE',
      signal: makeSignal('verify_captcha'),
    })
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('CONSOLE_PROBE'))
    logSpy.mockRestore()
  })
})

// ------------------------------------------------------------
// #11-#14  withGuard: 主路径 / PAUSE 重试 / 超时 / ABORT
// ------------------------------------------------------------

/** 构造一个 mock page，模拟 page.$(selector) 返回 ElementHandle 或 null */
function makeMockPage(selectorResults: Record<string, boolean> = {}) {
  return {
    $: vi.fn(async (sel: string) => {
      if (selectorResults[sel] === true) return { tagName: 'DIV' }
      if (selectorResults[sel] === false) return null
      return null
    }),
    waitForSelector: vi.fn(async () => undefined),
  }
}

describe('withGuard', () => {
  it('#11 no signal → executes fn directly (probe not even started for safe path)', async () => {
    const page = makeMockPage({})
    const fn = vi.fn().mockResolvedValue('ok')

    const result = await withGuard(page, fn)
    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('#12 detects PAUSE → waitForSelector(hidden) → waitForUserConfirm → retry fn', async () => {
    // 模拟时序：
    //   探针 1: captcha 命中 → PAUSE
    //   waitForSelector('.captcha-a', { state: 'hidden' }) → 解析（用户手动过了）
    //   waitForUserConfirm → 立即 resolve
    //   探针 2 重启 → 无信号 → 执行 fn → 成功
    const page = makeMockPage({ '.captcha-a': true })
    page.waitForSelector = vi.fn(async () => undefined)

    const fn = vi.fn().mockResolvedValue('recovered')
    const waitForUserConfirm = vi.fn().mockResolvedValue(undefined)

    const result = await withGuard(page, fn, {
      config: makeConfig({ probeIntervalMs: 1 }),
      waitForUserConfirm,
    })

    expect(result).toBe('recovered')
    expect(fn).toHaveBeenCalledTimes(1) // 仅一次 fn（带 retry 语义时是同一个 fn）
    expect(page.waitForSelector).toHaveBeenCalledWith(
      '.captcha-a',
      expect.objectContaining({ state: 'hidden' }),
    )
    expect(waitForUserConfirm).toHaveBeenCalledTimes(1)
  })

  it('#13 maxPauseMs 超时 → throws GuardError(ABORT_TODAY)', async () => {
    // waitForSelector 永远不 resolve（用户 10 分钟内未处理）
    const page = makeMockPage({ '.captcha-a': true })
    page.waitForSelector = vi.fn(() => new Promise(() => { /* never */ }))

    const fn = vi.fn()
    const waitForUserConfirm = vi.fn()

    await expect(
      withGuard(page, fn, {
        config: makeConfig({ probeIntervalMs: 1, maxPauseMs: 5 }),
      }),
    ).rejects.toBeInstanceOf(GuardError)

    // fn 必须未被调用（pause 后未恢复，不应执行业务）
    expect(fn).not.toHaveBeenCalled()
  })

  it('#14 ABORT_TODAY signal → throws immediately without retry', async () => {
    const page = makeMockPage({ '.rate-a': true })

    const fn = vi.fn()
    const waitForUserConfirm = vi.fn()

    await expect(
      withGuard(page, fn, {
        config: makeConfig({ probeIntervalMs: 1 }),
        waitForUserConfirm,
      }),
    ).rejects.toBeInstanceOf(GuardError)

    expect(fn).not.toHaveBeenCalled()
    expect(waitForUserConfirm).not.toHaveBeenCalled() // abort 不需用户确认
  })
})

// ------------------------------------------------------------
// #15-#16  probeRiskSignals: page.$ + 兜底 dialog
// ------------------------------------------------------------

describe('probeRiskSignals', () => {
  it('#15 uses page.$(selector) not page.evaluate', async () => {
    const page = makeMockPage({ '.captcha-a': true })
    const evaluate = vi.fn()

    await probeRiskSignals(page, makeConfig())

    expect(page.$).toHaveBeenCalledWith('.captcha-a')
    expect(evaluate).not.toHaveBeenCalled()
  })

  it('#16 fallbackDialogSelector 命中时 confidence=0.3', async () => {
    // 硬编码选择器全部未命中，但 [role="dialog"] 命中
    const page = makeMockPage({ '[role="dialog"]': true })
    const signals = await probeRiskSignals(page, makeConfig())

    expect(signals).toHaveLength(1)
    expect(signals[0].rawSelector).toBe('[role="dialog"]')
    expect(signals[0].confidence).toBeCloseTo(0.3)
    expect(signals[0].type).toBe('safe') // 兜底归类为 safe（让 evaluateSignal 进一步判断）
  })

  it('returns empty array when no selectors match', async () => {
    const page = makeMockPage({})
    const signals = await probeRiskSignals(page, makeConfig())
    expect(signals).toEqual([])
  })

  it('captcha selector hit → returns verify_captcha signal', async () => {
    const page = makeMockPage({ '.captcha-a': true })
    const signals = await probeRiskSignals(page, makeConfig())
    expect(signals).toHaveLength(1)
    expect(signals[0].type).toBe('verify_captcha')
    expect(signals[0].confidence).toBe(1)
  })
})

// ------------------------------------------------------------
// GuardError
// ------------------------------------------------------------

describe('GuardError', () => {
  it('carries the failing decision', () => {
    const decision = {
      action: 'abort_today' as const,
      reason: 'x',
      signal: makeSignal('rate_limit'),
    }
    const err = new GuardError(decision)
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('GuardError')
    expect(err.decision).toBe(decision)
  })
})