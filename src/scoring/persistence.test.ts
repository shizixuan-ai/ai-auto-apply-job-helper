// ============================================================
// scoring/persistence — Sprint 1C RED 测试 (TDD Step 1)
// ============================================================
// 覆盖维度：
//   P1. formatDimensionsForFeishu(ScoreResult) → JSON 字符串
//   P2. JSON 字符串 parse 回去仍能拿到 dimensions + totalReason（roundtrip）
//   P3. JSON 字符串必须包含 6 维字段名（防御 schema 漂移）
//
// TDD 状态：RED（persistence.ts 未创建，import 会失败）
// ============================================================

import { describe, it, expect } from 'vitest'

import { formatDimensionsForFeishu } from './persistence.js'
import type { ScoreResult } from '../types/index.js'

// ============================================================
// Fixture
// ============================================================

const SAMPLE_RESULT: ScoreResult = {
  totalScore: 0.81,
  totalReason: '总体匹配度高',
  dimensions: {
    education: { score: 0.8, reason: '本科匹配' },
    experience: { score: 0.9, reason: '7 年 Java 经验' },
    skill: { score: 0.7, reason: '技能 80% 覆盖' },
    project: { score: 0.85, reason: '万级 QPS' },
    stability: { score: 0.6, reason: '5 年 3 跳' },
    potential: { score: 0.75, reason: '成长性好' },
  },
}

// ============================================================
// TEST P1: formatDimensionsForFeishu → JSON 字符串
// ============================================================

describe('formatDimensionsForFeishu', () => {
  it('TEST P1: ScoreResult → JSON 字符串（含 dimensions + totalReason）', () => {
    const json = formatDimensionsForFeishu(SAMPLE_RESULT)

    // 必须是字符串
    expect(typeof json).toBe('string')

    // 必须能 parse 回 ScoreResult
    const parsed = JSON.parse(json)
    expect(parsed.dimensions).toEqual(SAMPLE_RESULT.dimensions)
    expect(parsed.totalReason).toBe('总体匹配度高')
  })

  // ============================================================
  // TEST P2: roundtrip — JSON 字符串 parse 回去仍能用
  // ============================================================

  it('TEST P2: formatDimensionsForFeishu 输出 → JSON.parse → 完整恢复 ScoreResult 详情', () => {
    const json = formatDimensionsForFeishu(SAMPLE_RESULT)
    const parsed = JSON.parse(json) as {
      dimensions: ScoreResult['dimensions']
      totalReason: string
    }

    // 6 维每个维度都存在
    expect(parsed.dimensions.education.score).toBe(0.8)
    expect(parsed.dimensions.experience.reason).toBe('7 年 Java 经验')
    expect(parsed.dimensions.skill.score).toBe(0.7)
    expect(parsed.dimensions.project.score).toBe(0.85)
    expect(parsed.dimensions.stability.score).toBe(0.6)
    expect(parsed.dimensions.potential.score).toBe(0.75)
    expect(parsed.totalReason).toBe('总体匹配度高')
  })

  // ============================================================
  // TEST P3: JSON 字符串必须含 6 维字段名（防御 schema 漂移）
  // ============================================================

  it('TEST P3: formatDimensionsForFeishu 输出含 6 维字段名（防 schema 漂移）', () => {
    const json = formatDimensionsForFeishu(SAMPLE_RESULT)

    expect(json).toContain('education')
    expect(json).toContain('experience')
    expect(json).toContain('skill')
    expect(json).toContain('project')
    expect(json).toContain('stability')
    expect(json).toContain('potential')
    expect(json).toContain('totalReason')
  })
})
