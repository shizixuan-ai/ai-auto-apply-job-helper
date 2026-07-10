// ============================================================
// verdict.test.ts — Sprint Smoke 6 (verdict 重构)
// ============================================================
// 目的：直接 import computeVerdict 而非 spawn 镜像实现
//
// 覆盖 8 case：
//   1. all passed → OK
//   2. failed + encryptBossId missing → BLOCK
//   3. failed + 软契约（无关键词） → WARN
//   4. timeout → WARN
//   5. 混合 OK + WARN → WARN
//   6. 混合 OK + BLOCK → BLOCK（BLOCK 优先）
//   7. jobDetail selector 0% → BLOCK
//   8. exit 2 SKIP（环境缺失） → WARN（不是硬契约）
//
// Sprint Smoke 6 设计动机：原 pre-commit.test.ts 用 node -e spawn 镜像
// 实现逻辑，是"假绿"反模式。重构后直接 import 真正实现。
// ============================================================

import { describe, it, expect } from 'vitest'
import { computeVerdict } from './verdict.mjs'

// ============================================================
// 工具：构造 mock result
// ============================================================
function mockResult(overrides: Partial<{
  id: string
  status: 'passed' | 'failed' | 'timeout' | 'skipped'
  exitCode: number | null
  stdout: string
  stderr: string
  duration_ms: number
  error: string | null
}> = {}) {
  return {
    id: overrides.id ?? 'test-rule',
    status: overrides.status ?? 'passed',
    exitCode: overrides.exitCode ?? 0,
    stdout: overrides.stdout ?? '',
    stderr: overrides.stderr ?? '',
    duration_ms: overrides.duration_ms ?? 100,
    error: overrides.error ?? null,
  }
}

describe('verdict.computeVerdict — 决策树', () => {
  it('TEST 1: 全部 passed → verdict=OK', () => {
    const results = [
      mockResult({ id: 'a', status: 'passed' }),
      mockResult({ id: 'b', status: 'passed' }),
    ]
    expect(computeVerdict(results)).toBe('OK')
  })

  it('TEST 2: failed + 硬契约关键词 encryptBossId missing → BLOCK', () => {
    const results = [
      mockResult({
        id: 'a',
        status: 'failed',
        exitCode: 1,
        stdout: 'encryptBossId missing in selector',
      }),
    ]
    expect(computeVerdict(results)).toBe('BLOCK')
  })

  it('TEST 3: failed + 软契约（无关键词） → WARN', () => {
    const results = [
      mockResult({
        id: 'a',
        status: 'failed',
        exitCode: 1,
        stdout: 'network blip',
      }),
    ]
    expect(computeVerdict(results)).toBe('WARN')
  })

  it('TEST 4: timeout → WARN', () => {
    const results = [
      mockResult({
        id: 'a',
        status: 'timeout',
        exitCode: null,
        stdout: 'partial output',
        error: 'timeout 60000ms',
      }),
    ]
    expect(computeVerdict(results)).toBe('WARN')
  })

  it('TEST 5: 混合 OK + WARN → WARN（任一 warn 即 warn）', () => {
    const results = [
      mockResult({ id: 'a', status: 'passed' }),
      mockResult({
        id: 'b',
        status: 'failed',
        exitCode: 1,
        stdout: 'soft error',
      }),
    ]
    expect(computeVerdict(results)).toBe('WARN')
  })

  it('TEST 6: 混合 OK + BLOCK → BLOCK（BLOCK 优先）', () => {
    const results = [
      mockResult({ id: 'a', status: 'passed' }),
      mockResult({
        id: 'b',
        status: 'failed',
        exitCode: 1,
        stdout: 'FieldNameNotFound',
      }),
    ]
    expect(computeVerdict(results)).toBe('BLOCK')
  })

  it('TEST 7: 硬契约 — jobDetail selector 0% 命中 → BLOCK', () => {
    const results = [
      mockResult({
        id: 'a',
        status: 'failed',
        exitCode: 1,
        stdout: 'jobDetail: 0/6 selectors matched',
      }),
    ]
    expect(computeVerdict(results)).toBe('BLOCK')
  })

  it('TEST 8: exit 2 (SKIP 环境未就绪) → WARN（不是硬契约）', () => {
    const results = [
      mockResult({
        id: 'feishu-schema-verify',
        status: 'failed',
        exitCode: 2,
        stderr: 'SKIP（环境未就绪）: FEISHU_APP_ID',
      }),
    ]
    expect(computeVerdict(results)).toBe('WARN')
  })

  it('TEST 9 (extra): empty results → OK', () => {
    expect(computeVerdict([])).toBe('OK')
  })

  it('TEST 10 (extra): encryptJobId missing → BLOCK', () => {
    const results = [
      mockResult({
        id: 'a',
        status: 'failed',
        exitCode: 1,
        stdout: 'encryptJobId missing',
      }),
    ]
    expect(computeVerdict(results)).toBe('BLOCK')
  })

  it('TEST 11 (extra): HR_UID not found → BLOCK', () => {
    const results = [
      mockResult({
        id: 'a',
        status: 'failed',
        exitCode: 1,
        stdout: 'HR_UID not found in record',
      }),
    ]
    expect(computeVerdict(results)).toBe('BLOCK')
  })

  it('TEST 12 (extra): 硬契约关键词在 stderr 而非 stdout 也要识别 → BLOCK', () => {
    const results = [
      mockResult({
        id: 'a',
        status: 'failed',
        exitCode: 1,
        stdout: '',
        stderr: 'FieldNameNotFound in HR_UID',
      }),
    ]
    expect(computeVerdict(results)).toBe('BLOCK')
  })
})