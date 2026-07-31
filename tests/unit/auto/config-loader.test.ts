// ============================================================
// tests/unit/auto/config-loader.test.ts — Sprint D-1a §16.5 RED
// ------------------------------------------------------------
// 覆盖: T21-T23 (per ADR-0016 §16.5 D-1a)
//   T21: 加载合法 auto.yaml → 解析成功 + safety 默认值合并 (max_failure_rate=0.3)
//   T22: zod 校验失败 (缺 searches[]) → AutoConfigError('schema_invalid', layer='CONFIG') + cause 链
//   T23: --quota 60 → quota.morning=24 + quota.afternoon=36 (40:60 比例拆)
// 纪律: §3.12 mock 注入 (os.tmpdir + fs.mkdtemp 隔离, 每 test 独立目录);
//       §3.13 错误分层验证 (AutoConfigError.layer='CONFIG');
//       §3.10 refactor: 0 改 Sprint C-2a/b 已有 caller (auto-handler deps 没变)
// 单账号红线守住: 仅 fs + yaml 解析, 0 触碰 BOSS
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import {
  loadAutoConfig,
  AutoConfigError,
  isAutoConfigError,
  type LoadAutoConfigOpts,
} from '../../../src/auto/config-loader'
import type { AutoConfig } from '../../../src/auto/config-schema'

// ─── Tmp dir 管理 (per §3.12 mock 隔离) ──────────────────────

let tmpDirs: string[] = []

const makeTmpDir = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(tmpdir(), 'config-loader-'))
  tmpDirs.push(dir)
  return dir
}

afterEach(async () => {
  for (const dir of tmpDirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => { /* best-effort */ })
  }
  tmpDirs = []
})

// ─── 合法 auto.yaml 模板 (per §16.3.3 docs/auto.example.yaml) ─

const validYAML = `
version: 1
searches:
  - keyword: "Java 后端"
    city: "北京"
    limit: 15
quota:
  morning: 40
  afternoon: 60
  weekly_cap: 500
warmup:
  enabled: true
  schedule:
    - { day_start: 1, cap: 50 }
    - { day_start: 8, cap: 70 }
    - { day_start: 15, cap: 100 }
throttle:
  morning_interval_ms: [180000, 240000]
  afternoon_interval_ms: [150000, 195000]
  jitter_pct: 20
  long_pause: { every_n_jobs: 20, duration_ms: [300000, 600000] }
  afternoon_mid_break: { after_job: 30, duration_ms: [600000, 900000] }
`

// ─── T21: 加载合法 yaml + safety 默认值合并 ──────────────────

describe('T21: 加载合法 auto.yaml + safety 默认值合并', () => {
  it('T21a: 完整 yaml → 解析成功 + 所有字段映射', async () => {
    const dir = await makeTmpDir()
    const yamlPath = path.join(dir, 'auto.yaml')
    await writeFile(yamlPath, validYAML)

    const result = await loadAutoConfig({
      configPath: yamlPath,
      phase: 'morning',
      date: '2026-07-29',
    } satisfies LoadAutoConfigOpts)

    expect(result.config.version).toBe(1)
    expect(result.config.searches).toHaveLength(1)
    expect(result.config.searches[0]?.keyword).toBe('Java 后端')
    expect(result.config.quota.morning).toBe(40)
    expect(result.config.quota.afternoon).toBe(60)
    expect(result.config.throttle.jitter_pct).toBe(20)
  })

  it('T21b: yaml 缺 safety 节点 → 默认值合并 (max_failure_rate=0.3)', async () => {
    const dir = await makeTmpDir()
    const yamlPath = path.join(dir, 'auto.yaml')
    // 故意不写 safety 节点, 验证默认合并
    const noSafetyYAML = validYAML.replace(/throttle:[\s\S]*$/, '') + `
throttle:
  morning_interval_ms: [180000, 240000]
  afternoon_interval_ms: [150000, 195000]
  jitter_pct: 20
  long_pause: { every_n_jobs: 20, duration_ms: [300000, 600000] }
  afternoon_mid_break: { after_job: 30, duration_ms: [600000, 900000] }
`
    await writeFile(yamlPath, noSafetyYAML)

    const result = await loadAutoConfig({
      configPath: yamlPath,
      phase: 'morning',
      date: '2026-07-29',
    } satisfies LoadAutoConfigOpts)

    // 关键 (缺口 2 暴露): safety 默认值
    expect(result.config.safety.max_failure_rate).toBe(0.3)  // per R3
    expect(result.config.safety.guard_trigger_policy).toBe('abort_day')  // per §16.3.3
    expect(result.config.safety.consecutive_guard_threshold).toBe(3)
    expect(result.config.safety.auto_regress_warmup).toBe(true)
  })

  it('T21c: yaml 含 safety 节点 → 自定义值覆盖默认', async () => {
    const dir = await makeTmpDir()
    const yamlPath = path.join(dir, 'auto.yaml')
    const customSafetyYAML = validYAML + `
safety:
  guard_trigger_policy: 'abort_run'
  max_failure_rate: 0.5
  consecutive_guard_threshold: 5
  auto_regress_warmup: false
`
    await writeFile(yamlPath, customSafetyYAML)

    const result = await loadAutoConfig({
      configPath: yamlPath,
      phase: 'morning',
      date: '2026-07-29',
    } satisfies LoadAutoConfigOpts)

    expect(result.config.safety.max_failure_rate).toBe(0.5)
    expect(result.config.safety.guard_trigger_policy).toBe('abort_run')
    expect(result.config.safety.consecutive_guard_threshold).toBe(5)
    expect(result.config.safety.auto_regress_warmup).toBe(false)
  })
})

// ============================================================
// T11: Sprint E-3.x — DEFAULT_CONFIG_PATH 改 cwd 相对 './auto.yaml' (Q5 A 决策)
// ============================================================
// 行为契约 (per grill-me Q5 A + Q6 A):
//   - 不传 configPath → loadAutoConfig 内部用 './auto.yaml' (cwd 相对)
//   - cwd 必须是 projectRoot 才能找到 auto.yaml
//   - expandHome('./auto.yaml') pass through (Q6 A 不动)
//   - 与 简历.yml 模式一致 (yaml-parser.ts:35)
//
// TDD 状态: RED (src 未改, default 仍 '~/.bapply/auto.yaml', 跑此测试应失败)

describe('T11: DEFAULT_CONFIG_PATH = "./auto.yaml" (cwd 相对, Q5 A)', () => {
  it('T11a: 不传 configPath → cwd=projectRoot 时找到 ./auto.yaml (unique keyword 防假绿)', async () => {
    // Arrange: 临时目录 + auto.yaml fixture (unique keyword 防 home 软链误中)
    const tmpDir = await makeTmpDir()
    await mkdir(path.join(tmpDir, '.bapply-state'), { recursive: true })
    const fixturePath = path.join(tmpDir, '.bapply-state', 'auto.yaml')
    const uniqueYAML = validYAML.replace('"Java 后端"', '"Q5A_UNIQUE_KEYWORD"')
    await writeFile(fixturePath, uniqueYAML, 'utf8')

    const originalCwd = process.cwd()
    process.chdir(tmpDir)
    try {
      // Act: 不传 configPath 触发 default
      const result = await loadAutoConfig({})

      // Assert: unique keyword 匹配 (说明 default 走 cwd 相对 './.bapply-state/auto.yaml' 找到 fixture)
      expect(result.config.searches[0].keyword).toBe('Q5A_UNIQUE_KEYWORD')
    } finally {
      process.chdir(originalCwd)
      await rm(tmpDir, { recursive: true, force: true })
    }
  })
})

// ─── T22: schema 校验失败 → AutoConfigError (layer='CONFIG') ─

describe('T22: zod 校验失败 → AutoConfigError', () => {
  it('T22a: 缺 searches[] → AutoConfigError("schema_invalid") + layer="CONFIG"', async () => {
    const dir = await makeTmpDir()
    const yamlPath = path.join(dir, 'auto.yaml')
    const noSearchesYAML = `
version: 1
quota: { morning: 40, afternoon: 60, weekly_cap: 500 }
throttle:
  morning_interval_ms: [180000, 240000]
  afternoon_interval_ms: [150000, 195000]
  jitter_pct: 20
  long_pause: { every_n_jobs: 20, duration_ms: [300000, 600000] }
  afternoon_mid_break: { after_job: 30, duration_ms: [600000, 900000] }
safety:
  guard_trigger_policy: 'abort_day'
  max_failure_rate: 0.3
  consecutive_guard_threshold: 3
  auto_regress_warmup: true
`
    await writeFile(yamlPath, noSearchesYAML)

    try {
      await loadAutoConfig({
        configPath: yamlPath,
        phase: 'morning',
        date: '2026-07-29',
      } satisfies LoadAutoConfigOpts)
      expect.fail('应该抛出 AutoConfigError')
    } catch (e) {
      expect(e).toBeInstanceOf(AutoConfigError)
      expect(isAutoConfigError(e)).toBe(true)
      expect((e as AutoConfigError).code).toBe('schema_invalid')
      expect((e as AutoConfigError).layer).toBe('CONFIG')  // per §3.13
    }
  })

  it('T22b: yaml 解析错 (缩进非法) → AutoConfigError("yaml_parse")', async () => {
    const dir = await makeTmpDir()
    const yamlPath = path.join(dir, 'auto.yaml')
    // 故意写非法 yaml (tab + space 混合)
    await writeFile(yamlPath, 'version: 1\n\tquota: { morning: 40 }')

    try {
      await loadAutoConfig({
        configPath: yamlPath,
        phase: 'morning',
        date: '2026-07-29',
      } satisfies LoadAutoConfigOpts)
      expect.fail('应该抛出 AutoConfigError')
    } catch (e) {
      expect(e).toBeInstanceOf(AutoConfigError)
      expect((e as AutoConfigError).code).toBe('yaml_parse')
      expect((e as AutoConfigError).layer).toBe('CONFIG')
      // cause 链保留 (per §3.13)
      expect((e as AutoConfigError).cause).toBeDefined()
    }
  })

  it('T22c: 文件不存在 → AutoConfigError("not_found")', async () => {
    const dir = await makeTmpDir()
    const yamlPath = path.join(dir, 'nonexistent.yaml')

    try {
      await loadAutoConfig({
        configPath: yamlPath,
        phase: 'morning',
        date: '2026-07-29',
      } satisfies LoadAutoConfigOpts)
      expect.fail('应该抛出 AutoConfigError')
    } catch (e) {
      expect(e).toBeInstanceOf(AutoConfigError)
      expect((e as AutoConfigError).code).toBe('not_found')
      expect((e as AutoConfigError).layer).toBe('CONFIG')
      // cause 应是 ENOENT 原始 error
      expect((e as AutoConfigError).cause).toBeDefined()
    }
  })
})

// ─── T23: --quota 60 → 比例拆 24/36 (缺口 3 修订) ───────────

describe('T23: --quota N 比例拆 (40:60 默认)', () => {
  it('T23a: --quota 60 + quota.morning=40/afternoon=60 → morning=24, afternoon=36', async () => {
    const dir = await makeTmpDir()
    const yamlPath = path.join(dir, 'auto.yaml')
    await writeFile(yamlPath, validYAML)

    const result = await loadAutoConfig({
      configPath: yamlPath,
      phase: 'morning',
      date: '2026-07-29',
      quotaOverride: 60,  // --quota 60 = 今天总共 60
    } satisfies LoadAutoConfigOpts)

    // 关键 (缺口 3 修订): 比例拆而非简单赋值
    // ratio = 40 / (40 + 60) = 0.4
    // morning = round(60 * 0.4) = 24
    // afternoon = 60 - 24 = 36
    // 总和 = 60 ✓
    expect(result.config.quota.morning).toBe(24)
    expect(result.config.quota.afternoon).toBe(36)
    expect(result.config.quota.morning + result.config.quota.afternoon).toBe(60)
  })

  it('T23b: 不传 quotaOverride → 原 yaml 配额不动', async () => {
    const dir = await makeTmpDir()
    const yamlPath = path.join(dir, 'auto.yaml')
    await writeFile(yamlPath, validYAML)

    const result = await loadAutoConfig({
      configPath: yamlPath,
      phase: 'morning',
      date: '2026-07-29',
    } satisfies LoadAutoConfigOpts)

    expect(result.config.quota.morning).toBe(40)  // 原值
    expect(result.config.quota.afternoon).toBe(60)  // 原值
  })

  it('T23c: --quota 100 + 50:50 yaml → morning=50, afternoon=50', async () => {
    const dir = await makeTmpDir()
    const yamlPath = path.join(dir, 'auto.yaml')
    const customYAML = validYAML.replace('morning: 40', 'morning: 50').replace('afternoon: 60', 'afternoon: 50')
    await writeFile(yamlPath, customYAML)

    const result = await loadAutoConfig({
      configPath: yamlPath,
      phase: 'morning',
      date: '2026-07-29',
      quotaOverride: 100,
    } satisfies LoadAutoConfigOpts)

    // ratio = 50 / (50 + 50) = 0.5
    expect(result.config.quota.morning).toBe(50)
    expect(result.config.quota.afternoon).toBe(50)
  })
})
