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
      config: makeConfig({ probeIntervalMs: 20 }),
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
        config: makeConfig({ probeIntervalMs: 20, maxPauseMs: 5 }),
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
        config: makeConfig({ probeIntervalMs: 20 }),
        waitForUserConfirm,
      }),
    ).rejects.toBeInstanceOf(GuardError)

    expect(fn).not.toHaveBeenCalled()
    expect(waitForUserConfirm).not.toHaveBeenCalled() // abort 不需用户确认
  })

  // ---- P0 fix: Step 2 (interval probe during fn) ----

  it('Step 2: fn execution期间 interval 探针命中 PAUSE → waitForSelector → confirm → 返回 fn 结果', async () => {
    // 设计：Step 1 同步探针返回 null（无信号），Step 2 interval 在 fn 期间命中 captcha
    // 关键：fn 必须足够慢（sleep 100ms），probeIntervalMs=20ms 让 interval 至少触发 4 次
    let captchaCount = 0
    const page = {
      $: vi.fn(async (sel: string) => {
        if (sel === '.captcha-a') {
          captchaCount++
          // 第 1 次（Step 1 同步探针）→ null
          // 第 2+ 次（Step 2 interval）→ captcha
          return captchaCount >= 2 ? { tagName: 'DIV' } : null
        }
        return null
      }),
      waitForSelector: vi.fn(async () => undefined),
    }

    const fn = vi.fn().mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 100))
      return 'fn_done'
    })
    const waitForUserConfirm = vi.fn().mockResolvedValue(undefined)

    const result = await withGuard(page, fn, {
      config: makeConfig({ probeIntervalMs: 20 }),
      waitForUserConfirm,
    })

    expect(result).toBe('fn_done')
    expect(fn).toHaveBeenCalledTimes(1)
    expect(page.$).toHaveBeenCalledWith('.captcha-a') // Step 1 + Step 2 多次
    expect(page.waitForSelector).toHaveBeenCalledWith(
      '.captcha-a',
      expect.objectContaining({ state: 'hidden' }),
    )
    expect(waitForUserConfirm).toHaveBeenCalledTimes(1)
  })

  it('Step 2: fn execution期间 interval 探针命中 ABORT_TODAY → throws GuardError, fn 结果被丢弃', async () => {
    // 设计：Step 1 null，Step 2 interval 期间命中 rate_limit
    let rateCount = 0
    const page = {
      $: vi.fn(async (sel: string) => {
        if (sel === '.rate-a') {
          rateCount++
          return rateCount >= 2 ? { tagName: 'DIV' } : null
        }
        return null
      }),
      waitForSelector: vi.fn(async () => undefined),
    }

    const fn = vi.fn().mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 100))
      return 'fn_done' // 这个结果会被丢弃
    })
    const waitForUserConfirm = vi.fn()

    await expect(
      withGuard(page, fn, {
        config: makeConfig({ probeIntervalMs: 20 }),
        waitForUserConfirm,
      }),
    ).rejects.toBeInstanceOf(GuardError)

    expect(fn).toHaveBeenCalledTimes(1) // fn 仍被调用
    expect(waitForUserConfirm).not.toHaveBeenCalled() // abort 不需用户确认
  })
})

// ------------------------------------------------------------
// #15-#16  probeRiskSignals: page.$ + 兜底 dialog
// ------------------------------------------------------------

describe('probeRiskSignals', () => {
  it('#15 uses page.$(selector) not page.evaluate (P0 fix: inject evaluate into page mock)', async () => {
    // P0 fix: evaluate 必须注入到 page 对象上，否则断言是 tautological
    const page = makeMockPage({ '.captcha-a': true })
    ;(page as any).evaluate = vi.fn()

    await probeRiskSignals(page, makeConfig())

    expect(page.$).toHaveBeenCalledWith('.captcha-a')
    // 关键断言：page.evaluate 必须未被调用
    expect((page as any).evaluate).not.toHaveBeenCalled()
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

// ------------------------------------------------------------
// P0 fixes (audit-derived)
// ------------------------------------------------------------

describe('P0: config input validation', () => {
  it('probeIntervalMs = 0 throws (防 setInterval 风暴)', async () => {
    const page = makeMockPage({})
    const fn = vi.fn().mockResolvedValue('ok')

    await expect(
      withGuard(page, fn, {
        config: makeConfig({ probeIntervalMs: 0 }),
      }),
    ).rejects.toThrow(/probeIntervalMs/)
  })

  it('probeIntervalMs 负数 throws', async () => {
    const page = makeMockPage({})
    const fn = vi.fn().mockResolvedValue('ok')

    await expect(
      withGuard(page, fn, {
        config: makeConfig({ probeIntervalMs: -1 }),
      }),
    ).rejects.toThrow(/probeIntervalMs/)
  })

  it('maxPauseMs = Infinity throws', async () => {
    const page = makeMockPage({})
    const fn = vi.fn().mockResolvedValue('ok')

    await expect(
      withGuard(page, fn, {
        config: makeConfig({ maxPauseMs: Infinity }),
      }),
    ).rejects.toThrow(/maxPauseMs/)
  })

  it('maxPauseMs = NaN throws', async () => {
    const page = makeMockPage({})
    const fn = vi.fn().mockResolvedValue('ok')

    await expect(
      withGuard(page, fn, {
        config: makeConfig({ maxPauseMs: NaN }),
      }),
    ).rejects.toThrow(/maxPauseMs/)
  })

  it('maxPauseMs = 0 throws (pause 立即超时等于永远不 pause)', async () => {
    const page = makeMockPage({})
    const fn = vi.fn().mockResolvedValue('ok')

    await expect(
      withGuard(page, fn, {
        config: makeConfig({ maxPauseMs: 0 }),
      }),
    ).rejects.toThrow(/maxPauseMs/)
  })
})

describe('P0: waitForUserConfirm default (防 pause 静默放行)', () => {
  it('不注入 waitForUserConfirm 时 PAUSE 抛错而非静默放行', async () => {
    const page = makeMockPage({ '.captcha-a': true })
    page.waitForSelector = vi.fn(async () => undefined) // 立即 resolve
    const fn = vi.fn()

    await expect(
      withGuard(page, fn, {
        config: makeConfig({ probeIntervalMs: 20 }),
        // waitForUserConfirm 不注入
      }),
    ).rejects.toThrow(/waitForUserConfirm.*not injected/i)
  })
})

describe('P0: OSNotifier osascript argv 注入防御', () => {
  let spawnMock: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    const cp = await import('node:child_process')
    spawnMock = cp.spawn as unknown as ReturnType<typeof vi.fn>
    spawnMock.mockReset()
  })

  afterEach(() => {
    spawnMock.mockReset()
  })

  it('darwin: body 含双引号/反斜杠 → title 和 body 作为位置参数（argv）传入，不进入 -e 字符串', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    spawnMock.mockImplementation((_cmd, _args) => ({
      on: (event: string, cb: (code: number) => void) => {
        if (event === 'exit') cb(0)
      },
    }))

    const notifier = new OSNotifier('darwin')
    const maliciousReason = '恶意 " -e display notification "; rm -rf /; \\'
    await notifier.notify({
      action: 'pause',
      reason: maliciousReason,
      signal: makeSignal('verify_captcha'),
    })

    // argv 模式断言：
    // 1. 必调用 osascript
    // 2. 最后两个 args 是 title 和 body（位置参数）
    // 3. 任何 -e 后面都不能包含恶意 body（注入防御核心）
    expect(spawnMock).toHaveBeenCalledWith(
      'osascript',
      expect.arrayContaining([
        '-e',
        expect.stringContaining('on run argv'),
        '-e',
        expect.stringContaining('display notification'),
        '-e',
        expect.stringContaining('end run'),
        'bapply 风控提示', // title
        maliciousReason, // body 通过 argv 传入，原样保留
      ]),
    )

    // 关键断言：所有 -e 后面的脚本片段都不能含恶意 body 内容（否则 body 进代码）
    const args = spawnMock.mock.calls[0][1] as string[]
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-e') {
        expect(args[i + 1]).not.toContain('rm -rf')
        expect(args[i + 1]).not.toContain('恶意')
      }
    }
  })

  it('darwin: body 是普通文本 → spawn args 含 title + body 作为位置参数', async () => {
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
      expect.arrayContaining([
        '-e',
        expect.stringContaining('display notification'),
        'bapply 风控提示',
        '请过验证',
      ]),
    )
  })
})

// ============================================================
// P1 backlog #1: notifier.notify 抛错不应阻塞 withGuard
// ============================================================
// 当前实现：handleSignal 内 `await notifier.notify(decision)` 没有 try/catch，
// 自定义 Notifier 实现一抛错就让整个 withGuard 阻断。
// 修复方案：notify 包 try/catch，抛错时 console fallback 到 [action] reason
// 输出，最后仍按 guard decision 走 abort / pause 流程。

describe('P1 backlog #1: notifier.notify try/catch', () => {
  it('Notifier.notify 抛错时不阻断 withGuard（abort_today 决策仍生效）', async () => {
    const brokenNotifier = {
      notify: vi.fn().mockRejectedValue(new Error('osascript crashed')),
    }
    const page = makeMockPage({ '.rate-limit-modal': true })
    page.waitForSelector = vi.fn().mockResolvedValue(undefined)
    const fn = vi.fn()

    // 当前实现：notifier 抛错直接传播 → withGuard 抛错（不是 GuardError）
    // 修复后：notify 抛错被 try/catch 抓住 → abort_today 决策继续生效 →
    //         withGuard 抛 GuardError(abort_today)
    await expect(
      withGuard(page, fn, {
        config: makeConfig({
          rateLimitSelectors: ['.rate-limit-modal'],
          probeIntervalMs: 20,
        }),
        notifier: brokenNotifier,
      }),
    ).rejects.toBeInstanceOf(GuardError)
  })

  it('Notifier.notify 抛错时控制台有 fallback 输出（业务可见）', async () => {
    const brokenNotifier = {
      notify: vi.fn().mockRejectedValue(new Error('console broken')),
    }
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const page = makeMockPage({ '.rate-limit-modal': true })
    page.waitForSelector = vi.fn().mockResolvedValue(undefined)

    await expect(
      withGuard(
        page,
        vi.fn(),
        {
          config: makeConfig({
            rateLimitSelectors: ['.rate-limit-modal'],
          }),
          notifier: brokenNotifier,
        },
      ),
    ).rejects.toBeInstanceOf(GuardError)

    // 至少有一次 console.log 或 console.error 调用
    const allCalls = [
      ...consoleSpy.mock.calls.map(String),
      ...consoleErrSpy.mock.calls.map(String),
    ].join('\n')
    expect(allCalls.length).toBeGreaterThan(0)

    consoleSpy.mockRestore()
    consoleErrSpy.mockRestore()
  })
})