import type { SearchFilters } from '../browser/index.js'

/**
 * CLI 搜索过滤 flag 的原始形态（commander 从 --job-type 等派生）。
 */
export interface SearchFilterOptions {
  jobType?: string
  salary?: string
  experience?: string
  degree?: string
}

/**
 * 把 CLI flag 映射成 BOSS SearchFilters（DEEP probe 2026-07-18 实测格式）。
 *
 * - 值原样透传为 BOSS 码字符串（如 --salary 406）
 * - 只保留有值的字段；全空 → 返回 undefined，
 *   使 searchJobs 调用点在无 flag 时与旧行为逐字节一致（回归安全）。
 */
export function buildSearchFilters(
  opts: SearchFilterOptions,
): SearchFilters | undefined {
  const filters: SearchFilters = {}
  for (const key of ['jobType', 'salary', 'experience', 'degree'] as const) {
    const value = opts[key]
    if (value) {
      filters[key] = value
    }
  }
  return Object.keys(filters).length > 0 ? filters : undefined
}
