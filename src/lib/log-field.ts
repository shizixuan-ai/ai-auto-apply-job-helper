// ============================================================
// src/lib/log-field.ts — 调试打印 helper
// ============================================================
// 目的：统一调试打印的截断策略，**绝对不静默截断**
// 教训：2026-07-14 fetchJobDetail 调试时 .slice(0,20) 误导归因
//       （以为 securityId 设计就 20 字符，实际是 200+）
// 纪律：~/.claude/CLAUDE.md §3.8 + memory feedback_debug_root_cause_discipline
// 原则：
//   1. 短字段（≤ maxLen）完整输出
//   2. 长字段输出 name + 长度 + head 预览（**绝不以 "..." 假装完整**）
//   3. null/undefined 明确输出（不省略）
//   4. 对象/数组 JSON.stringify（过长时同样输出长度）
// ============================================================

export interface LogFieldOptions {
  /** 字符串 / 对象最大长度（默认 80） */
  maxLen?: number
}

/**
 * 调试打印统一格式：`name=value` 或 `name=<head> length=<total>`
 *
 * @param name 字段名
 * @param value 字段值（任意类型）
 * @param opts.maxLen 字符串 / 对象最大长度（默认 80）
 * @returns 格式化后的字符串
 *
 * @example
 *   logField('count', 42)                          // 'count=42'
 *   logField('sid', 'a'.repeat(200))               // 'sid=aaaaa... length=200'
 *   logField('obj', { a: 1 })                      // 'obj={"a":1}'
 *   logField('big', { data: 'x'.repeat(500) })     // 'big={"data":"x... length=510'
 */
export function logField(
  name: string,
  value: unknown,
  opts: LogFieldOptions = {}
): string {
  const maxLen = opts.maxLen ?? 80

  // null / undefined —— 明确输出，避免被忽略
  if (value === null) return `${name}=null`
  if (value === undefined) return `${name}=undefined`

  // 数字 / 布尔 —— 直接输出
  if (typeof value === 'number' || typeof value === 'boolean') {
    return `${name}=${value}`
  }

  // 字符串
  if (typeof value === 'string') {
    if (value.length <= maxLen) {
      return `${name}=${value}`
    }
    // 长字符串：head + length（**绝不以 "..." 假装完整**）
    const headLen = Math.floor(maxLen / 2)
    const head = value.slice(0, headLen)
    return `${name}=${head} length=${value.length}`
  }

  // 对象 / 数组 —— JSON.stringify
  const json = JSON.stringify(value)
  if (json.length <= maxLen) {
    return `${name}=${json}`
  }
  // 长 JSON：head + length
  const headLen = Math.floor(maxLen / 2)
  const head = json.slice(0, headLen)
  return `${name}=${head} length=${json.length}`
}