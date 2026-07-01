// ============================================================
// 人类行为模拟 — GREEN 实现
// ============================================================
// 设计参见 §5.2.3 时序图（fill greet box 人类节奏 + 贝塞尔）
//
// 核心 API：
//   - humanDelay()：随机噪声 sleep
//   - randomBetween()：均匀分布随机
//   - generateBezierPath()：3 阶贝塞尔 + jitter 噪声
//   - bezierMove()：通过 page.mouse.move 沿曲线移动
//   - typeText()：focus → 逐字符键入（含 typo 回退 + 段落 pause）
// ============================================================

// ============================================================
// 类型
// ============================================================

export interface Point {
  x: number
  y: number
}

export interface BezierOptions {
  control1?: Point
  control2?: Point
  steps?: number
  jitter?: number
}

export interface BezierMoveOptions extends BezierOptions {
  delayMs?: number
}

export interface TypeTextOptions {
  minDelayMs?: number
  maxDelayMs?: number
  typoRate?: number
  pauseChance?: number
  pauseMinMs?: number
  pauseMaxMs?: number
}

export interface TypeTextResult {
  typed: number
  typos: number
}

export interface GuardedHumanPage {
  mouse: { move: (x: number, y: number) => Promise<void> }
  click: (sel: string) => Promise<void>
  focus: (sel: string) => Promise<void>
  keyboard: { press: (key: string) => Promise<void>; type: (text: string) => Promise<void> }
}

// ============================================================
// 纯函数
// ============================================================

/** 均匀分布随机（min ≤ v ≤ max） */
export function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min)
}

/**
 * 带噪声的 sleep（jitter=0.3 表示 ±30% 抖动）
 * 范围: [ms*(1-jitter), ms*(1+jitter)]
 */
export function humanDelay(ms: number, jitter = 0.3): Promise<void> {
  const factor = 1 + (Math.random() * 2 - 1) * jitter
  const actualMs = Math.max(1, ms * factor)
  return new Promise((resolve) => setTimeout(resolve, actualMs))
}

/**
 * 3 阶贝塞尔曲线 B(t) = (1-t)³P0 + 3(1-t)²tP1 + 3(1-t)t²P2 + t³P3
 * 默认 20 steps + 30% jitter
 */
export function generateBezierPath(
  from: Point,
  to: Point,
  options: BezierOptions = {},
): Point[] {
  const steps = options.steps ?? 20
  const jitter = options.jitter ?? 0.3

  // 自动生成 control 点（如果未指定）：基于 from→to 方向 + 随机偏移
  const c1 = options.control1 ?? {
    x: from.x + (to.x - from.x) * 0.25 + (Math.random() - 0.5) * 100,
    y: from.y + (to.y - from.y) * 0.25 + (Math.random() - 0.5) * 100,
  }
  const c2 = options.control2 ?? {
    x: from.x + (to.x - from.x) * 0.75 + (Math.random() - 0.5) * 100,
    y: from.y + (to.y - from.y) * 0.75 + (Math.random() - 0.5) * 100,
  }

  const path: Point[] = []
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const omt = 1 - t
    let x =
      omt ** 3 * from.x +
      3 * omt ** 2 * t * c1.x +
      3 * omt * t ** 2 * c2.x +
      t ** 3 * to.x
    let y =
      omt ** 3 * from.y +
      3 * omt ** 2 * t * c1.y +
      3 * omt * t ** 2 * c2.y +
      t ** 3 * to.y

    // jitter：在每个点上加随机噪声（jitter=0 时不加）
    if (jitter > 0) {
      x += (Math.random() - 0.5) * jitter * 20
      y += (Math.random() - 0.5) * jitter * 20
    }

    path.push({ x, y })
  }
  return path
}

/** 随机 ASCII 字符（用于 typo 注入） */
function randomWrongChar(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz'
  return alphabet[Math.floor(Math.random() * alphabet.length)]
}

// ============================================================
// Playwright 集成
// ============================================================

/** 沿贝塞尔曲线移动鼠标 */
export async function bezierMove(
  page: GuardedHumanPage,
  from: Point,
  to: Point,
  options: BezierMoveOptions = {},
): Promise<Point[]> {
  const path = generateBezierPath(from, to, options)
  const delayMs = options.delayMs ?? 50

  for (const point of path) {
    await page.mouse.move(point.x, point.y)
    await humanDelay(delayMs, 0.3)
  }
  return path
}

/** 逐字符键入（含 typo 回退 + 段落 pause） */
export async function typeText(
  page: GuardedHumanPage,
  selector: string,
  text: string,
  options: TypeTextOptions = {},
): Promise<TypeTextResult> {
  const minDelayMs = options.minDelayMs ?? 30
  const maxDelayMs = options.maxDelayMs ?? 120
  const typoRate = options.typoRate ?? 0.01
  const pauseChance = options.pauseChance ?? 0.1
  const pauseMinMs = options.pauseMinMs ?? 800
  const pauseMaxMs = options.pauseMaxMs ?? 2000

  // 先 focus（评审补充 #11）
  await page.focus(selector)
  await humanDelay(200, 0.3)

  let typed = 0
  let typos = 0

  for (const char of text) {
    // typo 注入
    if (Math.random() < typoRate) {
      await page.keyboard.press(randomWrongChar())
      await humanDelay(80, 0.3)
      await page.keyboard.press('Backspace')
      await humanDelay(120, 0.3)
      typos++
    }
    // 正常键入
    await page.keyboard.press(char)
    await humanDelay(randomBetween(minDelayMs, maxDelayMs), 0.3)
    typed++

    // 段落 pause
    if (Math.random() < pauseChance) {
      await humanDelay(randomBetween(pauseMinMs, pauseMaxMs), 0.3)
    }
  }

  return { typed, typos }
}