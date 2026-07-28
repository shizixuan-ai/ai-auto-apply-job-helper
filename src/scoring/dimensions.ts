// ============================================================
// scoring/dimensions — Sprint 1C GREEN
// ============================================================
// 6 维评分的权重配置 + 加权求和纯函数
//
// 类型定义（ScoreDimensions / ScoreWeights）放 types/index.ts（避免循环依赖）
// 数值常量 + 计算函数放本文件
// ============================================================

import type { ScoreDimensions, ScoreWeights } from '../types/index.js'

// Re-export 类型（让测试可以从 './dimensions.js' 导入，方便 import 路径最短）
export type { ScoreDimensions, ScoreWeights }

/**
 * 默认权重（Sprint 1C 用户权重表，2026-07-19 确认）
 *
 * 学历匹配 10% / 经验相关 30% / 技能契合 10% /
 * 项目深度 30% / 稳定性 10% / 综合潜力 10%  → 合计 1.00
 */
export const DEFAULT_WEIGHTS: ScoreWeights = {
  education: 0.1,
  experience: 0.3,
  skill: 0.1,
  project: 0.3,
  stability: 0.1,
  potential: 0.1,
}

/**
 * 计算加权总分（保留 3 位小数）
 *
 * 公式：total = Σ(dimension.score × weight)
 *
 * @throws Error 权重和不归一化（≠ 1）
 */
export function computeWeightedTotal(
  dimensions: ScoreDimensions,
  weights: ScoreWeights,
): number {
  const sum =
    weights.education +
    weights.experience +
    weights.skill +
    weights.project +
    weights.stability +
    weights.potential

  // 用 epsilon 比较浮点，避免精度误判
  if (Math.abs(sum - 1) > 1e-9) {
    throw new Error(`权重和不归一化（=${sum}，应 = 1）`)
  }

  const raw =
    dimensions.education.score * weights.education +
    dimensions.experience.score * weights.experience +
    dimensions.skill.score * weights.skill +
    dimensions.project.score * weights.project +
    dimensions.stability.score * weights.stability +
    dimensions.potential.score * weights.potential

  // 保留 3 位小数，避免浮点尾数（0.7950000000000001）
  return Math.round(raw * 1000) / 1000
}
