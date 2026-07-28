// ============================================================
// scoring/persistence — Sprint 1C GREEN
// ============================================================
// 6 维评分的持久化辅助（飞书长文本字段塞 JSON）
//
// 设计：
//   - 输入: ScoreResult (含 totalScore + totalReason + dimensions)
//   - 输出: JSON 字符串（pretty print，飞书长文本可读）
//   - 格式: { dimensions, totalReason }（不含 totalScore，避免和飞书「分数」字段重复）
//
// 未来扩展（如需带 version 号）→ 在此文件加 wrapper，不改调用方
// ============================================================

import type { ScoreResult } from '../types/index.js'

/**
 * 把 6 维评分详情序列化为飞书长文本字段
 *
 * 输出格式：JSON 字符串，包含 dimensions + totalReason
 * 不含 totalScore（飞书「分数」字段已存，避免重复）
 */
export function formatDimensionsForFeishu(scoreResult: ScoreResult): string {
  return JSON.stringify(
    {
      dimensions: scoreResult.dimensions,
      totalReason: scoreResult.totalReason,
    },
    null,
    2,
  )
}
