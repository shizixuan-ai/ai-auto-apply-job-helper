// ============================================================
// pre-commit.test.ts — Sprint Smoke 3 hook 入口测试
// ============================================================
// 覆盖：
//   - 顶层 main() 自动调用（git 触发时）— 但本测试不直接测 main()
//
// 设计决策（Sprint Smoke 6）：
//   - verdict 决策树已抽到 scripts/smoke/verdict.mjs
//   - verdict 测试见 verdict.test.ts（直接 import，测真实实现）
//   - 本文件不再包含 spawn node -e 镜像逻辑（避免假绿反模式）
//
// getStagedFiles / writeReport 等 helper 暂未单独测（无副作用风险）
// ============================================================

import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('pre-commit hook — 文件存在性 + 结构', () => {
  it('TEST 1: pre-commit 文件存在且可执行', () => {
    const path = '/Users/wangjixue/Documents/projects/ai-auto-apply-job-helper/scripts/git-hooks/pre-commit'
    expect(existsSync(path)).toBe(true)
  })

  it('TEST 2: pre-commit 文件 import 了 verdict.mjs（重构完成标志）', () => {
    const path = '/Users/wangjixue/Documents/projects/ai-auto-apply-job-helper/scripts/git-hooks/pre-commit'
    const content = readFileSync(path, 'utf-8')
    expect(content).toContain("import { computeVerdict } from '../smoke/verdict.mjs'")
  })

  it('TEST 3: pre-commit 文件不再含内嵌 computeVerdict 函数', () => {
    const path = '/Users/wangjixue/Documents/projects/ai-auto-apply-job-helper/scripts/git-hooks/pre-commit'
    const content = readFileSync(path, 'utf-8')
    expect(content).not.toMatch(/^function computeVerdict/m)
  })
})