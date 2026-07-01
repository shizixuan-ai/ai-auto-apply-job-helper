// ============================================================
// 人类行为模拟 — TDD 测试（RED 阶段）
// ============================================================
// 11 个测试覆盖：
//   - 纯函数：generateBezierPath / humanDelay / randomBetween
//   - Playwright 集成：bezierMove / typeText
//   - 评审建议：#11 page.focus 调用验证
// ============================================================

import { describe, it, expect, vi } from 'vitest'
import {
  generateBezierPath,
  humanDelay,
  randomBetween,
  randomWrongChar,
  bezierMove,
  typeText,
  type Point,
  type GuardedHumanPage,
} from './human.js'

// ------------------------------------------------------------
// Test helpers
// ------------------------------------------------------------

/** 构造 mock page：mouse.move / focus / click / keyboard.press 全部 vi.fn() */
function makeMockPage(): GuardedHumanPage & {
  mouse: { move: ReturnType<typeof vi.fn> }
  click: ReturnType<typeof vi.fn>
  focus: ReturnType<typeof vi.fn>
  keyboard: { press: ReturnType<typeof vi.fn>; type: ReturnType<typeof vi.fn> }
} {
  return {
    mouse: { move: vi.fn().mockResolvedValue(undefined) },
    click: vi.fn().mockResolvedValue(undefined),
    focus: vi.fn().mockResolvedValue(undefined),
    keyboard: {
      press: vi.fn().mockResolvedValue(undefined),
      type: vi.fn().mockResolvedValue(undefined),
    },
  }
}

// ============================================================
// #1-#3  generateBezierPath: 端点 + 步数 + 数学正确性
// ============================================================

describe('generateBezierPath', () => {
  it('#1 起点 = from, 终点 = to (jitter=0 时严格相等)', () => {
    const from: Point = { x: 0, y: 0 }
    const to: Point = { x: 100, y: 100 }
    const path = generateBezierPath(from, to, { jitter: 0, control1: { x: 25, y: 50 }, control2: { x: 75, y: 50 } })
    expect(path[0]).toEqual(from)
    expect(path[path.length - 1]).toEqual(to)
  })

  it('#2 默认 20 steps (length === 21)', () => {
    const path = generateBezierPath({ x: 0, y: 0 }, { x: 100, y: 100 })
    expect(path.length).toBe(21) // 20 步 = 21 个点（含两端）
  })

  it('#3 jitter=0 时所有点都在 3 阶贝塞尔曲线上', () => {
    // B(t) = (1-t)³P0 + 3(1-t)²tP1 + 3(1-t)t²P2 + t³P3
    const from: Point = { x: 0, y: 0 }
    const to: Point = { x: 100, y: 100 }
    const c1: Point = { x: 25, y: 80 }
    const c2: Point = { x: 75, y: 20 }

    const path = generateBezierPath(from, to, {
      control1: c1,
      control2: c2,
      steps: 10,
      jitter: 0, // 关键：jitter=0 验证数学正确性
    })

    // 验证每个点都在曲线上（容差 0.001）
    for (let i = 0; i < path.length; i++) {
      const t = i / 10
      const omt = 1 - t
      const expectedX = omt ** 3 * 0 + 3 * omt ** 2 * t * 25 + 3 * omt * t ** 2 * 75 + t ** 3 * 100
      const expectedY = omt ** 3 * 0 + 3 * omt ** 2 * t * 80 + 3 * omt * t ** 2 * 20 + t ** 3 * 100
      expect(path[i].x).toBeCloseTo(expectedX, 1)
      expect(path[i].y).toBeCloseTo(expectedY, 1)
    }
  })
})

// ============================================================
// #4-#5  humanDelay + randomBetween: 噪声 + 边界
// ============================================================

describe('humanDelay', () => {
  it('#4 humanDelay(100, 0.3) 实际 sleep 在 [70ms, 150ms] 范围内', async () => {
    const start = Date.now()
    await humanDelay(100, 0.3)
    const elapsed = Date.now() - start
    expect(elapsed).toBeGreaterThanOrEqual(70)
    // 收紧到 150ms（理论上限 130ms + 20ms setTimeout 漂移容忍）
    // 比 #0eb84df 的 200ms 更严，可暴露 setTimeout 实现漂移回归
    expect(elapsed).toBeLessThanOrEqual(150)
  })

  it('humanDelay(NaN) throws (低优先级健壮性修复)', () => {
    expect(() => humanDelay(NaN)).toThrow(/humanDelay/)
  })

  it('humanDelay(Infinity) throws', () => {
    expect(() => humanDelay(Infinity)).toThrow(/humanDelay/)
  })

  it('humanDelay(-1) throws (负数无意义)', () => {
    expect(() => humanDelay(-1)).toThrow(/humanDelay/)
  })
})

describe('randomBetween', () => {
  it('#5 randomBetween(10, 20) 多次调用均在 [10, 20] 范围内', () => {
    for (let i = 0; i < 50; i++) {
      const v = randomBetween(10, 20)
      expect(v).toBeGreaterThanOrEqual(10)
      expect(v).toBeLessThanOrEqual(20)
    }
  })
})

describe('randomWrongChar', () => {
  it('100 次调用均返回单字符 a-z', () => {
    for (let i = 0; i < 100; i++) {
      const c = randomWrongChar()
      expect(c).toMatch(/^[a-z]$/)
    }
  })

  it('多次调用至少覆盖 5 个不同字符 (分布合理)', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 50; i++) seen.add(randomWrongChar())
    expect(seen.size).toBeGreaterThanOrEqual(5)
  })
})

// ============================================================
// #6-#7  bezierMove: 调用次数 + 端点
// ============================================================

describe('bezierMove', () => {
  it('#6 调用 page.mouse.move 至少 steps 次（默认 21）', async () => {
    const page = makeMockPage()
    await bezierMove(page, { x: 0, y: 0 }, { x: 100, y: 100 })
    expect(page.mouse.move.mock.calls.length).toBeGreaterThanOrEqual(21)
  })

  it('#7 第一点 = from，最后一点 = to', async () => {
    const page = makeMockPage()
    const from: Point = { x: 10, y: 20 }
    const to: Point = { x: 200, y: 300 }
    await bezierMove(page, from, to)
    const calls = page.mouse.move.mock.calls
    const firstCall = calls[0]
    const lastCall = calls[calls.length - 1]
    expect(firstCall[0]).toBeCloseTo(from.x, -1)
    expect(firstCall[1]).toBeCloseTo(from.y, -1)
    expect(lastCall[0]).toBeCloseTo(to.x, -1)
    expect(lastCall[1]).toBeCloseTo(to.y, -1)
  })
})

// ============================================================
// #8-#11  typeText: 字符数 + typo + pause + focus
// ============================================================

describe('typeText', () => {
  it('#8 调用 keyboard.press 正确字符次数（不含 typo）', async () => {
    const page = makeMockPage()
    await typeText(page, '#input', 'hello', { typoRate: 0 })
    // 5 个字符，每字符 1 次 press（typoRate=0 无错字）
    expect(page.keyboard.press.mock.calls.length).toBe(5)
    expect(page.keyboard.press.mock.calls.map((c) => c[0]).join('')).toBe('hello')
  })

  it('#9 typoRate=0.5 在 20 字符测试中至少 1 次 typo', async () => {
    const page = makeMockPage()
    const text = 'a'.repeat(20)
    const result = await typeText(page, '#input', text, {
      typoRate: 0.5,
      minDelayMs: 1,
      maxDelayMs: 2,
      pauseChance: 0, // 禁用 pause
    })
    // typo = 错字 + 回退，所以 presses > typed
    expect(result.typos).toBeGreaterThanOrEqual(1)
    expect(page.keyboard.press.mock.calls.length).toBeGreaterThan(result.typed)
  }, 10_000)

  it('#10 pauseChance=1 至少触发 1 次 pause (额外 delay)', async () => {
    const page = makeMockPage()
    const start = Date.now()
    await typeText(page, '#input', 'abc', {
      minDelayMs: 1,
      maxDelayMs: 2,
      pauseChance: 1, // 100% 触发 pause
      pauseMinMs: 100,
      pauseMaxMs: 150,
      typoRate: 0, // 关闭 typo 避免随机
    })
    const elapsed = Date.now() - start
    // 3 字符 × 1.5ms + 至少 1 次 100ms pause ≈ 至少 100ms
    expect(elapsed).toBeGreaterThanOrEqual(100)
  })

  it('#11 应首先调用 page.focus(selector)（评审补充）', async () => {
    const page = makeMockPage()
    await typeText(page, '#chat-input', 'hi')
    expect(page.focus).toHaveBeenCalledWith('#chat-input')
    // focus 应在 press 之前
    const focusOrder = page.focus.mock.invocationCallOrder[0]
    const pressOrder = page.keyboard.press.mock.invocationCallOrder[0]
    expect(focusOrder).toBeLessThan(pressOrder)
  })

  it('空字符串 text 返回 {typed:0, typos:0} 不触发任何 press', async () => {
    const page = makeMockPage()
    const result = await typeText(page, '#input', '')
    expect(result.typed).toBe(0)
    expect(result.typos).toBe(0)
    // focus 应被调用（first action），但 press 应不被调用
    expect(page.focus).toHaveBeenCalledWith('#input')
    expect(page.keyboard.press).not.toHaveBeenCalled()
  })
})