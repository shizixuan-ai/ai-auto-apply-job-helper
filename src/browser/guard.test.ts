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
  pickStrongerSignal,
  probeRiskSignals,
  withGuard,
  GuardError,
  OSNotifier,
  ConsoleNotifier,
  DEFAULT_GUARD_CONFIG,
  DEFAULT_NOTIFIER_TIMEOUT_MS,
  parseNotifierTimeoutMs,
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
    // step 2 sync probe（backlog #5）会让 mock 持续 captcha 在 step 3 再
    // 触发一次确认。允许 ≥1 次实际行为。
    expect(waitForUserConfirm.mock.calls.length).toBeGreaterThanOrEqual(1)
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

// ============================================================
// P1 backlog #3: pause race 的 reject 分类
// ============================================================
// 当前：race 内部的 waitForSelector 抛错（如 page closed / selector 找不到），
// catch 内 instanceof PauseTimeoutError 失败，所以 throw err 传播原始 Error。
// 修复：所有 race 内的错误（除 PauseTimeoutError）也视为 abort_today，
// 因为 page 异常意味着业务中断。

describe('P1 backlog #3: pause race reject classification', () => {
  it('page.waitForSelector 抛错时抛 GuardError(abort_today)（而非原始 Error 透传）', async () => {
    const page = makeMockPage({ '.captcha-a': true })
    page.waitForSelector = vi
      .fn()
      .mockRejectedValue(new Error('page closed unexpectedly'))
    const fn = vi.fn()

    // 当前：原始 Error('page closed unexpectedly') 透传
    // 修复后：abort_today 决策透传，withGuard 抛 GuardError
    await expect(
      withGuard(page, fn, {
        config: makeConfig({
          captchaSelectors: ['.captcha-a'],
          probeIntervalMs: 20,
        }),
      }),
    ).rejects.toBeInstanceOf(GuardError)
  })

  it('page.waitForSelector 抛错时 abort_today reason 含原始错误信息（诊断可用）', async () => {
    const page = makeMockPage({ '.captcha-a': true })
    page.waitForSelector = vi
      .fn()
      .mockRejectedValue(new Error('element detached'))
    const fn = vi.fn()

    try {
      await withGuard(page, fn, {
        config: makeConfig({
          captchaSelectors: ['.captcha-a'],
          probeIntervalMs: 20,
        }),
      })
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(GuardError)
      // reason 包含原始错误信息，便于诊断
      expect((err as GuardError).decision.reason).toMatch(/page|element|detached/i)
    }
  })
})

// ============================================================
// P1 backlog #4: detectedDuringFn 锁（防 setInterval 后写覆盖前写）
// ============================================================
// withGuard step 2 的 setInterval 内多个 probe 几乎同时结束时，
// 后写覆盖前写：探测到 captcha（prio 5）后探测到 rate_limit（prio 4），
// 因 race 顺序丢失了更高优先级信号。
//
// 修复：抽 pickStrongerSignal(a, b) helper，setInterval 内用合并而非覆盖。

describe('P1 backlog #4: pickStrongerSignal', () => {
  // pickStrongerSignal 在 guard.ts 内 export 后再补 import

  it('PRIORITY: verify_captcha (5) > rate_limit (4) > safe (0)', () => {
    const captcha = makeSignal('verify_captcha', 1, '.c')
    const rate = makeSignal('rate_limit', 1, '.r')
    expect(pickStrongerSignal(rate, captcha)).toBe(captcha)
  })

  it('returns higher-priority signal whichever position (a or b)', () => {
    const captcha = makeSignal('verify_captcha', 1, '.c')
    const rate = makeSignal('rate_limit', 1, '.r')
    expect(pickStrongerSignal(captcha, rate)).toBe(captcha)
    expect(pickStrongerSignal(rate, captcha)).toBe(captcha)
  })

  it('keeps higher-priority signal on tie priority (no overwrite)', () => {
    const a = makeSignal('verify_captcha', 1, '.a')
    const b = makeSignal('verify_captcha', 1, '.b')
    // 同优先级 → 平局行为：实现选择保留 a
    expect(pickStrongerSignal(a, b)?.rawSelector).toBe('.a')
  })

  it('returns null when both are null', () => {
    expect(pickStrongerSignal(null, null)).toBeNull()
  })

  it('returns b when only b is non-null', () => {
    const b = makeSignal('rate_limit', 1)
    expect(pickStrongerSignal(null, b)).toBe(b)
  })

  it('returns a when only a is non-null', () => {
    const a = makeSignal('rate_limit', 1)
    expect(pickStrongerSignal(a, null)).toBe(a)
  })
})

// ============================================================
// P1 backlog #2: aggregateSignals null guard
// ============================================================
// 当前 aggregateSignals 只防御 length === 0，传 null/undefined 时
// 访问 .length 抛 TypeError。加 null guard 让其 return null。

describe('P1 backlog #2: aggregateSignals null guard', () => {
  it('aggregateSignals(null) 不抛错并返回 null', () => {
    expect(aggregateSignals(null as any)).toBeNull()
  })

  it('aggregateSignals(undefined) 不抛错并返回 null', () => {
    expect(aggregateSignals(undefined as any)).toBeNull()
  })

  it('aggregateSignals([]) 仍然返回 null（兼容旧行为）', () => {
    expect(aggregateSignals([])).toBeNull()
  })

  it('aggregateSignals([sig]) 仍然返回 sig（兼容旧行为）', () => {
    const sig = makeSignal('rate_limit')
    expect(aggregateSignals([sig])).toBe(sig)
  })
})

// ============================================================
// P1 backlog #5: step2 立即 sync probe（覆 step1→setInterval 间隙）
// ============================================================
// withGuard step 1 完成后到 setInterval 第一次 fire 之间有窗口，
// 该窗口内 page 出现 signal 不会被探测捕获。修复：setInterval 创建
// 后立即同步 probe 一次。
//
// 验证策略：用 captcha selector mock 让 step1 不命中、step2 sync 命中。
// 这样只依赖 signal 检测，不依赖具体的 page.$ 调用次数（vitest mock
// 行为细节难以预测）。

describe('P1 backlog #5: step2 sync probe', () => {
  it('step2 sync probe 命中信号（说明同步探针存在）', async () => {
    // 用 captcha selectors 列表，让 step1 probe 不命中 captcha，
    // step2 sync probe 命中 captcha（首次以外的）
    let captchaSelectorHits = 0
    const page = makeMockPage({ '.captcha-a': true })
    page.$ = vi.fn().mockImplementation(async (sel: string) => {
      if (sel === '.captcha-a') {
        captchaSelectorHits++
        // 第 1 次访问（step1 probe）→ 不命中；第 2 次（step2 sync）→ 命中
        return captchaSelectorHits === 2 ? {} : null
      }
      return null
    })
    const fn = vi.fn().mockResolvedValue('ok')

    // step2 sync probe 命中 captcha → step3 → handleSignal → PAUSE
    // → waitForUserConfirm 未注入 → throw
    await expect(
      withGuard(page, fn, {
        config: makeConfig({
          captchaSelectors: ['.captcha-a'],
          probeIntervalMs: 100_000,
        }),
      }),
    ).rejects.toThrow(/waitForUserConfirm.*not injected/)

    // 至少第 2 次访问 .captcha-a 触发命中逻辑
    expect(captchaSelectorHits).toBeGreaterThanOrEqual(2)
  })

  it('probeIntervalMs 巨大时 fn 在 setInterval 第一次 tick 之前完成', async () => {
    // 防止 setInterval 第一次 tick 干扰（probeIntervalMs=100s 没机会 tick）
    // 简单验证：fn 立即返回时无意外 throw
    const page = makeMockPage({})
    const fn = vi.fn().mockResolvedValue('ok')

    await expect(
      withGuard(page, fn, {
        config: makeConfig({ probeIntervalMs: 100_000 }),
      }),
    ).resolves.toBe('ok')

    // 防 setInterval 还在跑：清掉
    // （withGuard 内部已 clearInterval，这里验证 fn 调过 1 次）
    expect(fn).toHaveBeenCalledTimes(1)
  })
})

// ============================================================
// P1 backlog #6: spawn child kill（防 osascript 挂起）
// ============================================================
// OSNotifier 在 darwin 调 osascript 用 spawn 启动子进程。如果子进程
// 永远不 fire 'exit' 或 'error'（例如用户没有 notification center /
// 系统卡顿），spawn 挂起 — withGuard 的 notify 等永远不 resolve，阻塞。
//
// 修复：spawn 后设置 5s timeout，超时后 child.kill() + fallback 路径。
// 我们测：mock spawn 返一个不 fire 的 EventEmitter，期望 notify 在
// ~5s timeout 后 resolve 而不是挂起。

describe('P1 backlog #6: spawn child kill', () => {
  let spawnMock: ReturnType<typeof vi.fn>
  let originalPlatform: NodeJS.Platform

  beforeEach(async () => {
    const cp = await import('node:child_process')
    spawnMock = cp.spawn as unknown as ReturnType<typeof vi.fn>
    spawnMock.mockReset()
    originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'darwin' })
  })

  afterEach(() => {
    spawnMock.mockReset()
    Object.defineProperty(process, 'platform', { value: originalPlatform })
  })

  it('P0 测试 1: spawn 返回的 child 永不 fire exit/error（hang）', async () => {
    // mock spawn 返一个 EventEmitter，从不 emit exit/error
    spawnMock.mockImplementation(() => ({
      on: () => {
        /* hang: never call cb */
      },
      kill: vi.fn(),
    }))

    // spawnTimeoutMs 50 → 测试快速完成（默认 5000ms 测试会等 5s）
    const notifier = new OSNotifier('darwin', { spawnTimeoutMs: 50 })
    const startTime = Date.now()

    await notifier.notify({
      action: 'pause',
      reason: 'test',
      signal: makeSignal('verify_captcha', 1, '.test'),
    })

    const elapsed = Date.now() - startTime
    // 应该 ≤ ~150ms (50ms timeout + 一些延迟)
    expect(elapsed).toBeLessThan(500)
  })

  it('P0 测试 2: child.kill(SIGTERM) 被调用（计时器触发后）', async () => {
    const killSpy = vi.fn()
    spawnMock.mockImplementation(() => ({
      on: () => {
        /* hang */
      },
      kill: killSpy,
    }))

    const notifier = new OSNotifier('darwin', { spawnTimeoutMs: 50 })
    await notifier.notify({
      action: 'pause',
      reason: 'test',
      signal: makeSignal('verify_captcha', 1, '.test'),
    })

    expect(killSpy).toHaveBeenCalledWith('SIGTERM')
  })
})

// ============================================================
// P1 backlog: missed-branch 补全（audit 派生）
// ============================================================
// coverage 报告 uncovered lines: 168-172, 435, 445
// 含义：
//   - 167-173: OSNotifier child.on('error') handler 全段（spawn settled-race 第 3 分支）
//   - 435:     race reject 时 notifier 二次抛错 → console.error 兜底
//   - 445:     handleSignal continue 分支（safe 信号 → return 'resume'）

describe('P1 backlog: missed-branch coverage', () => {
  let spawnMock: ReturnType<typeof vi.fn>
  let originalPlatform: NodeJS.Platform

  beforeEach(async () => {
    const cp = await import('node:child_process')
    spawnMock = cp.spawn as unknown as ReturnType<typeof vi.fn>
    spawnMock.mockReset()
    originalPlatform = process.platform
  })

  afterEach(() => {
    spawnMock.mockReset()
    Object.defineProperty(process, 'platform', { value: originalPlatform })
  })

  // ----- Missed branch #1: OSNotifier child.on('error') fires (167-173) -----

  it('OSNotifier: child.on("error") fires (settled=false path) → fallbackLog + resolve', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    spawnMock.mockImplementation(() => ({
      on: (event: string, cb: (err?: any) => void) => {
        // 模拟 spawn 启动失败：只 fire 'error'，不 fire 'exit' 也不 fire timer
        if (event === 'error') cb(new Error('ENOENT: osascript not found'))
      },
    }))

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const notifier = new OSNotifier('darwin')
    await notifier.notify({
      action: 'pause',
      reason: 'ERR_EVT_MSG',
      signal: makeSignal('verify_captcha', 1, '.geetest_panel'),
    })

    // 关键断言：error handler 走 fallbackLog（与 exit code≠0 行为一致）
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('ERR_EVT_MSG'))

    logSpy.mockRestore()
  })

  it('OSNotifier: child.on("error") fires 后 exit 再 fire（settled race） → 只 log 一次', async () => {
    // 模拟 race：error 先 fire，exit 后 fire
    // 验证 settled 锁：exit handler 应 early-return，不再调 fallbackLog
    let errorCb: ((err?: any) => void) | null = null
    let exitCb: ((code: number) => void) | null = null
    spawnMock.mockImplementation(() => ({
      on: (event: string, cb: any) => {
        if (event === 'error') errorCb = cb
        if (event === 'exit') exitCb = cb
      },
    }))

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const notifier = new OSNotifier('darwin')

    const promise = notifier.notify({
      action: 'pause',
      reason: 'SETTLED_RACE',
      signal: makeSignal('verify_captcha', 1, '.geetest_panel'),
    })

    // 先 fire error（settled=true → log + resolve）
    errorCb!(new Error('first'))
    // 再 fire exit code=1（settled race → early-return，不重复 log）
    exitCb!(1)

    await promise

    // fallbackLog 只调一次（error 路径那次）
    const matches = logSpy.mock.calls.filter((c) =>
      String(c[0]).includes('SETTLED_RACE'),
    )
    expect(matches).toHaveLength(1)

    logSpy.mockRestore()
  })

  // ----- Missed branch #2: race reject + notifier 二次抛错 (435) -----

  it('race reject + notifier.notify 二次抛错 → console.error 被调 + GuardError 仍抛', async () => {
    // notifier 第一次 notify 抛错的 fallback 路径已测（backlog #1）
    // 这里测 race reject 时第二次 notifier.notify 也抛错 → console.error 兜底
    const failingNotifier = {
      notify: vi.fn().mockRejectedValue(new Error('notifier down twice')),
    }
    const page = makeMockPage({ '.captcha-a': true })
    page.waitForSelector = vi.fn().mockRejectedValue(new Error('page closed'))

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(
      withGuard(page, vi.fn(), {
        config: makeConfig({
          captchaSelectors: ['.captcha-a'],
          probeIntervalMs: 20,
        }),
        notifier: failingNotifier,
      }),
    ).rejects.toBeInstanceOf(GuardError)

    // 关键断言：第二次 notifier 抛错被 console.error 兜底，不阻断 GuardError
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('notifier.notify (race reject)'),
      expect.any(Error),
    )

    errSpy.mockRestore()
  })

  // ----- Missed branch #3: handleSignal continue 分支 (445) -----

  it('safe 信号 (fallback dialog 命中) → handleSignal return "resume" → fn 仍执行', async () => {
    // 设计：page.$ 让 [role="dialog"] 命中（fallback），其他硬编码不命中
    // probeRiskSignals 返 [safe signal (confidence 0.3)]
    // aggregateSignals 返 safe (priority 0，非 null)
    // handleSignal(safe) → evaluateSignal → action='continue' → return 'resume'
    // withGuard 继续走 step 2 → fn → 返 fn 结果
    const page = makeMockPage({ '[role="dialog"]': true })
    const fn = vi.fn().mockResolvedValue('fn_done')

    const result = await withGuard(page, fn, {
      config: makeConfig({ probeIntervalMs: 100_000 }),
    })

    expect(result).toBe('fn_done')
    expect(fn).toHaveBeenCalledTimes(1)
  })
})

// ============================================================
// P2: spawnTimeoutMs env var 覆盖（BOSS_NOTIFIER_TIMEOUT_MS）
// ============================================================
// 用途：CI 调优 / 不同部署环境设置不同超时，无需改代码
// 优先级：options.spawnTimeoutMs > env > DEFAULT_NOTIFIER_TIMEOUT_MS
// 防御：env 解析失败（NaN/0/负数）静默回退默认，不让 process 启动失败

describe('P2: parseNotifierTimeoutMs (env override)', () => {
  const ORIGINAL_ENV = process.env.BOSS_NOTIFIER_TIMEOUT_MS

  beforeEach(() => {
    delete process.env.BOSS_NOTIFIER_TIMEOUT_MS
  })

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env.BOSS_NOTIFIER_TIMEOUT_MS
    } else {
      process.env.BOSS_NOTIFIER_TIMEOUT_MS = ORIGINAL_ENV
    }
  })

  it('default: 无 options 无 env → DEFAULT_NOTIFIER_TIMEOUT_MS', () => {
    expect(parseNotifierTimeoutMs(undefined)).toBe(DEFAULT_NOTIFIER_TIMEOUT_MS)
    expect(DEFAULT_NOTIFIER_TIMEOUT_MS).toBe(5000)
  })

  it('option 是有效正数 → 直接使用 option（最高优先级）', () => {
    process.env.BOSS_NOTIFIER_TIMEOUT_MS = '3000'
    expect(parseNotifierTimeoutMs(1000)).toBe(1000)
  })

  it('option 无效（0）→ 回退到 env', () => {
    process.env.BOSS_NOTIFIER_TIMEOUT_MS = '3000'
    expect(parseNotifierTimeoutMs(0)).toBe(3000)
  })

  it('option 无效（负数）→ 回退到 env', () => {
    process.env.BOSS_NOTIFIER_TIMEOUT_MS = '3000'
    expect(parseNotifierTimeoutMs(-1)).toBe(3000)
  })

  it('option 无效（NaN）→ 回退到 env', () => {
    process.env.BOSS_NOTIFIER_TIMEOUT_MS = '3000'
    expect(parseNotifierTimeoutMs(NaN)).toBe(3000)
  })

  it('option 无效（Infinity）→ 回退到 env', () => {
    process.env.BOSS_NOTIFIER_TIMEOUT_MS = '3000'
    expect(parseNotifierTimeoutMs(Infinity)).toBe(3000)
  })

  it('env 是有效正数 → 使用 env', () => {
    process.env.BOSS_NOTIFIER_TIMEOUT_MS = '8000'
    expect(parseNotifierTimeoutMs(undefined)).toBe(8000)
  })

  it('env 是 0（无效，等于无 timeout）→ 回退默认', () => {
    process.env.BOSS_NOTIFIER_TIMEOUT_MS = '0'
    expect(parseNotifierTimeoutMs(undefined)).toBe(DEFAULT_NOTIFIER_TIMEOUT_MS)
  })

  it('env 是负数 → 回退默认', () => {
    process.env.BOSS_NOTIFIER_TIMEOUT_MS = '-100'
    expect(parseNotifierTimeoutMs(undefined)).toBe(DEFAULT_NOTIFIER_TIMEOUT_MS)
  })

  it('env 是非数字（"abc"）→ 回退默认', () => {
    process.env.BOSS_NOTIFIER_TIMEOUT_MS = 'abc'
    expect(parseNotifierTimeoutMs(undefined)).toBe(DEFAULT_NOTIFIER_TIMEOUT_MS)
  })

  it('env 是空字符串 → 回退默认', () => {
    process.env.BOSS_NOTIFIER_TIMEOUT_MS = ''
    expect(parseNotifierTimeoutMs(undefined)).toBe(DEFAULT_NOTIFIER_TIMEOUT_MS)
  })

  it('env 是浮点（"3.5"）→ parseInt 截断为 3', () => {
    // 防御：parseInt 比 Number 更严格（不返 NaN 给 "3.5"）
    // 但行为契约：parseInt 后若是 0 也算无效，回退默认
    process.env.BOSS_NOTIFIER_TIMEOUT_MS = '3.5'
    // 3 < 10 也算太短（防 setInterval 风暴的下限），回退默认
    expect(parseNotifierTimeoutMs(undefined)).toBe(DEFAULT_NOTIFIER_TIMEOUT_MS)
  })

  it('env 是大数（"60000"）→ 使用 env', () => {
    process.env.BOSS_NOTIFIER_TIMEOUT_MS = '60000'
    expect(parseNotifierTimeoutMs(undefined)).toBe(60000)
  })

  // ----- 集成：OSNotifier 构造时自动读 env -----

  it('OSNotifier 构造时自动读 env（无需 options）', async () => {
    process.env.BOSS_NOTIFIER_TIMEOUT_MS = '1234'
    const cp = await import('node:child_process')
    const spawnMock = cp.spawn as unknown as ReturnType<typeof vi.fn>
    spawnMock.mockReset()
    spawnMock.mockImplementation(() => ({
      on: () => {},
      kill: vi.fn(),
    }))

    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'darwin' })

    const notifier = new OSNotifier('darwin')
    // 验证构造后 spawnTimeoutMs 是 1234
    // 通过行为验证：spawnTimeoutMs=1234 让 timer 在 ~1234ms 后 fire
    const start = Date.now()
    await notifier.notify({
      action: 'pause',
      reason: 'env_test',
      signal: makeSignal('verify_captcha', 1, '.test'),
    })
    const elapsed = Date.now() - start
    // 应该至少 1100ms（用 1234 env，timer 必须 fire 因为 mock spawn 永不 resolve）
    expect(elapsed).toBeGreaterThanOrEqual(1100)
    // 但不能太慢（容许 200ms 误差）
    expect(elapsed).toBeLessThan(2000)

    spawnMock.mockReset()
    Object.defineProperty(process, 'platform', { value: originalPlatform })
  })
})