// ============================================================
// LazyLoadError — Sprint 2E 懒加载防御的结构化错误
// ------------------------------------------------------------
// ADR-0004 决策 2：从 src/browser/index.ts 抽离，便于复用 + 测试
// 字段含义：
//   - url: BOSS job_detail URL
//   - selectors: 尝试过的 selector 列表
//   - lengthHistory: 每个 selector 在 1s/3s/10s 三个时间点的 textLength
//   - cause: 'all_selectors_lazy' | 'wapi_lazy_then_goto_lazy'
// ============================================================

/**
 * Sprint 2E：JD 长度阈值（防御懒加载假绿）
 *
 * BOSS 首屏只渲染 60% JD，3 秒后才补齐剩余 40%（实测 T0=551 字符 → T+3s=917 字符）。
 * 旧 waitForSelector 一出现就 resolve，拿到 551 字符的不完整 JD → 评分偏低但仍 scored > 0。
 * 防御策略：双路都校验长度，不够视为懒加载未完成。
 *
 * 默认 500 字符针对中文 JD（实测 60% JD 已超 500，但完整 JD 通常 800-2000）。
 * 可通过环境变量 MIN_JD_LENGTH_THRESHOLD 调高（英文 JD）或调低（极短岗位）。
 *
 * 注：模块顶部只读一次 env，所以测试隔离需用 vi.stubEnv + 动态 import。
 */
export const DEFAULT_MIN_JD_LENGTH = Number(process.env.MIN_JD_LENGTH_THRESHOLD ?? 500)

export class LazyLoadError extends Error {
  readonly url: string
  readonly selectors: string[]
  readonly lengthHistory: Record<string, number[]>
  readonly cause: string

  constructor(args: { url: string; selectors: string[]; lengthHistory: Record<string, number[]>; cause: string }) {
    const historyStr = Object.entries(args.lengthHistory)
      .map(([sel, lens]) => `    ${sel}: [${lens.join(', ')}]`)
      .join('\n')
    const msg =
      `LazyLoadError: 所有 selector 都未拿到完整 JD（≥ ${DEFAULT_MIN_JD_LENGTH} 字符）\n` +
      `  cause: ${args.cause}\n` +
      `  url: ${args.url}\n` +
      `  selectors tried: ${args.selectors.join(', ')}\n` +
      `  length history (每个 selector 的 textLength 时间序列):\n${historyStr}\n` +
      `  可能原因：(1) BOSS 改了 HTML 结构 (2) 懒加载 API 挂了 (3) 网络/反爬拦截`
    super(msg)
    this.name = 'LazyLoadError'
    this.url = args.url
    this.selectors = args.selectors
    this.lengthHistory = args.lengthHistory
    this.cause = args.cause
  }
}