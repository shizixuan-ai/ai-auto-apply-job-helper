// ============================================================
// rule-matcher.test.ts — Sprint Smoke 2 RED
// ============================================================
// 契约：
//   - matchRules(changedFiles, rules) → SmokeTrigger[]
//   - 只匹配 changedFiles 命中的 pattern
//   - required_for 精确匹配（不是 glob）
//   - skip_when 存在则返回空 triggers 数组 + skipped:true（标记 skip）
//   - 默认必跑 vitest + tsc（如果 rules 有 default 段）
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function freshMatcher() {
  vi.resetModules()
  return await import('./rule-matcher.mjs')
}

let tmpDir: string
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'rule-matcher-test-'))
})
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function writeRules(yaml: string) {
  const path = join(tmpDir, 'rules.yaml')
  writeFileSync(path, yaml, 'utf-8')
  return path
}

describe('matchRules — 基础 pattern 匹配', () => {
  it('TEST 1: changedFiles 命中 src/browser/** → 触发 boss-probe', async () => {
    writeRules(`
rules:
  - pattern: "src/browser/**"
    triggers:
      - id: boss-probe
        command: "npx tsx scripts/probe-boss-api.mjs Java后端"
        timeout_sec: 60
        reason: "BOSS 抓取层变更验证"
`)
    const { matchRules } = await freshMatcher()
    const result = matchRules(['src/browser/index.ts'], join(tmpDir, 'rules.yaml'))
    expect(result.triggers).toHaveLength(1)
    expect(result.triggers[0]?.id).toBe('boss-probe')
  })

  it('TEST 2: changedFiles 不命中 src/browser/** → 不触发', async () => {
    writeRules(`
rules:
  - pattern: "src/browser/**"
    triggers:
      - id: boss-probe
        command: "echo probe"
        timeout_sec: 60
`)
    const { matchRules } = await freshMatcher()
    const result = matchRules(['src/cli/handlers/foo.ts'], join(tmpDir, 'rules.yaml'))
    expect(result.triggers).toHaveLength(0)
  })

  it('TEST 3: 多个 pattern 命中 → 触发多个', async () => {
    writeRules(`
rules:
  - pattern: "src/browser/**"
    triggers:
      - id: boss-probe
        command: "echo probe"
        timeout_sec: 60
  - pattern: "src/feishu/**"
    triggers:
      - id: feishu-schema
        command: "echo feishu"
        timeout_sec: 30
`)
    const { matchRules } = await freshMatcher()
    const result = matchRules(
      ['src/browser/index.ts', 'src/feishu/index.ts'],
      join(tmpDir, 'rules.yaml'),
    )
    expect(result.triggers.map((t) => t.id).sort()).toEqual(['boss-probe', 'feishu-schema'])
  })
})

describe('matchRules — skip_when 降级', () => {
  it('TEST 4 (mock): skip_when exec 返回 0 → 触发 skipped push，triggers 为空', async () => {
    writeRules(`
rules:
  - pattern: "src/browser/**"
    skip_when: "curl -s http://localhost:9222/json/version > /dev/null"
    triggers:
      - id: boss-probe
        command: "npx tsx scripts/probe-boss-api.mjs Java后端"
        timeout_sec: 60
`)
    const { matchRules } = await freshMatcher()
    // mock execSync 返 0 → skip_when 满足 → 此 rule 被 skip
    const result = matchRules(
      ['src/browser/index.ts'],
      join(tmpDir, 'rules.yaml'),
      { execSyncFn: () => 0 },
    )
    expect(result.triggers).toHaveLength(0)
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0]?.reason).toContain('skip_when satisfied')
  })

  it('TEST 5 (mock): skip_when exec 返非 0 → triggers 触发', async () => {
    writeRules(`
rules:
  - pattern: "src/browser/**"
    skip_when: "curl -s http://localhost:9222/json/version > /dev/null"
    triggers:
      - id: boss-probe
        command: "npx tsx scripts/probe-boss-api.mjs"
    timeout_sec: 60
`)
    const { matchRules } = await freshMatcher()
    const result = matchRules(
      ['src/browser/index.ts'],
      join(tmpDir, 'rules.yaml'),
      { execSyncFn: () => 1 },
    )
    expect(result.triggers).toHaveLength(1)
    expect(result.triggers[0]?.id).toBe('boss-probe')
    expect(result.skipped).toHaveLength(0)
  })
})

describe('matchRules — required_for 精确匹配', () => {
  it('TEST 6: required_for 命中 → 触发', async () => {
    writeRules(`
rules:
  - pattern: "src/browser/**"
    required_for:
      - "src/browser/index.ts"
    triggers:
      - id: boss-probe
        command: "echo probe"
        timeout_sec: 60
`)
    const { matchRules } = await freshMatcher()
    const result = matchRules(
      ['src/browser/index.ts', 'src/browser/logger.ts'],
      join(tmpDir, 'rules.yaml'),
    )
    expect(result.triggers).toHaveLength(1)
  })

  it('TEST 7: pattern 命中但 required_for 不命中 → 不触发', async () => {
    writeRules(`
rules:
  - pattern: "src/browser/**"
    required_for:
      - "src/browser/index.ts"
    triggers:
      - id: boss-probe
        command: "echo probe"
        timeout_sec: 60
`)
    const { matchRules } = await freshMatcher()
    // 只改 logger.ts → pattern 命中但 required_for 不命中 → 不触发
    const result = matchRules(
      ['src/browser/logger.ts'],
      join(tmpDir, 'rules.yaml'),
    )
    expect(result.triggers).toHaveLength(0)
  })

  it('TEST 8: required_for 多文件（数组），任一命中 → 触发', async () => {
    writeRules(`
rules:
  - pattern: "src/browser/**"
    required_for:
      - "src/browser/index.ts"
      - "src/browser/guard.ts"
    triggers:
      - id: boss-probe
        command: "echo probe"
        timeout_sec: 60
`)
    const { matchRules } = await freshMatcher()
    const result = matchRules(
      ['src/browser/guard.ts'],  // 只改 guard.ts（index.ts 没改）
      join(tmpDir, 'rules.yaml'),
    )
    expect(result.triggers).toHaveLength(1)
  })
})

describe('matchRules — 边界条件', () => {
  it('TEST 9: empty pattern → 跳过此 rule', async () => {
    writeRules(`
rules:
  - pattern: ""
    triggers:
      - id: should-not-fire
        command: "echo x"
        timeout_sec: 60
`)
    const { matchRules } = await freshMatcher()
    const result = matchRules(['src/any.ts'], join(tmpDir, 'rules.yaml'))
    expect(result.triggers).toHaveLength(0)
  })
})