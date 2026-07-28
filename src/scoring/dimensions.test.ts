// ============================================================
// scoring/dimensions — Sprint 1C RED 测试 (TDD Step 1)
// ============================================================
// 覆盖维度（纯函数单元测试，不依赖 LLM/飞书）：
//   D1. DEFAULT_WEIGHTS × 6 维 → 加权求和正确
//   D2. 自定义权重 → 加权值按新权重算
//   D3. 权重和 ≠ 1 → 抛 Error（归一化防御）
//   D4. 总分精度（保留 3 位小数，避免浮点尾数）
//   D5. 边界：6 维全 0 → 0；6 维全 1 → 1
//   D6. DEFAULT_WEIGHTS 总和必须精确 = 1（配置 sanity check）
//
// TDD 状态：RED（模块不存在，import + 类型全部失败 → vitest 报错）
// ============================================================

import { describe, it, expect } from 'vitest'
import {
  DEFAULT_WEIGHTS,
  computeWeightedTotal,
  type ScoreDimensions,
  type ScoreWeights,
} from './dimensions.js'

// ============================================================
// Fixture
// ============================================================

const FULL_DIMENSIONS: ScoreDimensions = {
  education: { score: 0.8, reason: '本科 985' },
  experience: { score: 0.9, reason: '7 年 Java' },
  skill: { score: 0.7, reason: '技能 80% 覆盖' },
  project: { score: 0.85, reason: '万级 QPS' },
  stability: { score: 0.6, reason: '5 年 3 跳' },
  potential: { score: 0.75, reason: '成长性好' },
}

// ============================================================
// TEST D1: 默认权重 × 标准 6 维 → 加权求和
// ============================================================
// 计算：
//   0.8*0.1 + 0.9*0.3 + 0.7*0.1 + 0.85*0.3 + 0.6*0.1 + 0.75*0.1
//   = 0.08 + 0.27 + 0.07 + 0.255 + 0.06 + 0.075
//   = 0.81
// ============================================================

describe('computeWeightedTotal', () => {
  it('TEST D1: DEFAULT_WEIGHTS × 6 维 → total = 0.81', () => {
    const total = computeWeightedTotal(FULL_DIMENSIONS, DEFAULT_WEIGHTS)

    expect(total).toBeCloseTo(0.81, 3)
  })

  // ============================================================
  // TEST D2: 自定义权重 → 加权求和
  // ============================================================

  it('TEST D2: 自定义权重覆盖默认 → 加权值按新权重算', () => {
    // 全部权重集中到 skill 维 (1.0)
    const customWeights: ScoreWeights = {
      education: 0,
      experience: 0,
      skill: 1.0,
      project: 0,
      stability: 0,
      potential: 0,
    }

    const total = computeWeightedTotal(FULL_DIMENSIONS, customWeights)

    // skill.score = 0.7 → total = 0.7
    expect(total).toBeCloseTo(0.7, 3)
  })

  // ============================================================
  // TEST D3: 权重和 ≠ 1 → 抛 Error
  // ============================================================

  it('TEST D3: 权重和不归一化（≠1）→ 抛 Error', () => {
    const invalidWeights: ScoreWeights = {
      education: 0.5,
      experience: 0.5,
      skill: 0.5, // 合计 = 1.5（不归一化）
      project: 0,
      stability: 0,
      potential: 0,
    }

    expect(() => computeWeightedTotal(FULL_DIMENSIONS, invalidWeights)).toThrow(
      /权重和不归一化/,
    )
  })

  // ============================================================
  // TEST D4: 总分精度（保留 3 位小数）
  // ============================================================
  // 计算：
  //   0.8*0.1 + 0.85*0.3 + 0.7*0.1 + 0.85*0.3 + 0.6*0.1 + 0.75*0.1
  //   = 0.08 + 0.255 + 0.07 + 0.255 + 0.06 + 0.075
  //   = 0.795
  // 期望：精确等于 0.795（不能是 0.7950000000000001）

  it('TEST D4: 加权求和结果保留 3 位小数（避免飞书显示长串小数）', () => {
    const dims: ScoreDimensions = {
      education: { score: 0.8, reason: '' },
      experience: { score: 0.85, reason: '' },
      skill: { score: 0.7, reason: '' },
      project: { score: 0.85, reason: '' },
      stability: { score: 0.6, reason: '' },
      potential: { score: 0.75, reason: '' },
    }

    const total = computeWeightedTotal(dims, DEFAULT_WEIGHTS)

    // 精确等于 0.795（不允许多余尾数）
    expect(total).toBe(0.795)
  })

  // ============================================================
  // TEST D5: 边界值（每维 0 / 1）
  // ============================================================

  it('TEST D5: 6 维全 0 → total = 0；6 维全 1 → total = 1', () => {
    const allZero: ScoreDimensions = {
      education: { score: 0, reason: '' },
      experience: { score: 0, reason: '' },
      skill: { score: 0, reason: '' },
      project: { score: 0, reason: '' },
      stability: { score: 0, reason: '' },
      potential: { score: 0, reason: '' },
    }
    const allOne: ScoreDimensions = {
      education: { score: 1, reason: '' },
      experience: { score: 1, reason: '' },
      skill: { score: 1, reason: '' },
      project: { score: 1, reason: '' },
      stability: { score: 1, reason: '' },
      potential: { score: 1, reason: '' },
    }

    expect(computeWeightedTotal(allZero, DEFAULT_WEIGHTS)).toBe(0)
    expect(computeWeightedTotal(allOne, DEFAULT_WEIGHTS)).toBe(1)
  })

  // ============================================================
  // TEST D6: DEFAULT_WEIGHTS 总和必须精确 = 1（配置 sanity）
  // ============================================================

  it('TEST D6: DEFAULT_WEIGHTS 总和必须精确 = 1（防御配置漂移）', () => {
    const sum =
      DEFAULT_WEIGHTS.education +
      DEFAULT_WEIGHTS.experience +
      DEFAULT_WEIGHTS.skill +
      DEFAULT_WEIGHTS.project +
      DEFAULT_WEIGHTS.stability +
      DEFAULT_WEIGHTS.potential

    expect(sum).toBe(1)
  })
})
