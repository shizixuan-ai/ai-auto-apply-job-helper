// ============================================================
// tests/unit/cli/handlers/auto-config-init-handler.test.ts — Sprint D-1c §16.5 RED
// ------------------------------------------------------------
// 覆盖: T24 (per ADR-0016 §16.5 D-1c)
//   T24: init-config 同时生成 auto.yaml + account-meta.json 2 个文件 + atomic write
//     - T24a: 全新目录 → 创建 + 写 2 文件 + 自动 init
//     - T24b: 文件已存在 + 未传 --force → skipped='exists' + 0 覆盖
//     - T24c: 文件已存在 + --force=true → 覆盖 + atomic
//     - T24d: account-meta.json 字段 = createDefaultAccountMeta
//     - T24e: auto.yaml 用 AutoConfigSchema safeParse 校验通过
// 纪律: §3.13 错误分层 (AccountMetaError 复用);
//       §3.12 mock 隔离 (os.tmpdir + fs.mkdtemp);
//       §3.10 refactor: 0 改 cli/index.ts (新增 .command 注册)
// 单账号红线守住: 仅 fs 写模板, 0 触碰 BOSS
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import {
  runAutoInitConfig,
  type InitConfigOpts,
} from '../../../../src/cli/handlers/auto-config-init-handler'
import { AutoConfigSchema } from '../../../../src/auto/config-schema'

// ─── Tmp dir 管理 (per §3.12) ────────────────────────────────

let tmpDirs: string[] = []

const makeTmpDir = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(tmpdir(), 'auto-config-init-'))
  tmpDirs.push(dir)
  return dir
}

afterEach(async () => {
  for (const dir of tmpDirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => { /* best-effort */ })
  }
  tmpDirs = []
})

// ─── 辅助: 检查文件存在 ─────────────────────────────────────

async function exists(filepath: string): Promise<boolean> {
  try {
    await access(filepath)
    return true
  } catch {
    return false
  }
}

// ─── T24: init-config 同时生成 2 文件 (D-1c 缺口 4 完整闭环) ──

describe('T24: init-config 同时生成 auto.yaml + account-meta.json', () => {
  it('T24a: 全新目录 (不存在) → 自动创建 + 写 2 文件 + created=true', async () => {
    const dir = await makeTmpDir()
    const configDir = path.join(dir, 'fresh-config')
    const configPath = path.join(configDir, 'auto.yaml')
    const metaPath = path.join(configDir, 'account-meta.json')

    // 前置: 目录不存在
    expect(await exists(configDir)).toBe(false)

    const result = await runAutoInitConfig({ configDir, force: false })

    // 1. created=true
    expect(result.created).toBe(true)
    expect(result.skipped).toBeUndefined()

    // 2. 2 文件路径
    expect(result.configPath).toBe(configPath)
    expect(result.metaPath).toBe(metaPath)

    // 3. 目录自动创建 (F4 mkdir -p)
    expect(await exists(configDir)).toBe(true)

    // 4. 2 文件都存在
    expect(await exists(configPath)).toBe(true)
    expect(await exists(metaPath)).toBe(true)
  })

  it('T24b: 文件已存在 + 未传 --force → created=false + skipped="exists" + 0 覆盖', async () => {
    const dir = await makeTmpDir()
    const configDir = dir
    const configPath = path.join(configDir, 'auto.yaml')
    const metaPath = path.join(configDir, 'account-meta.json')

    // 预写: 用户已有 auto.yaml 内容
    const userYaml = 'version: 1\n# 用户自定义内容\nsearches: [{ keyword: "老 keyword" }]\n'
    await import('node:fs/promises').then(m => m.writeFile(configPath, userYaml))

    const result = await runAutoInitConfig({ configDir, force: false })

    // 1. 不覆盖
    expect(result.created).toBe(false)
    expect(result.skipped).toBe('exists')

    // 2. 用户原内容未被改
    const after = await readFile(configPath, 'utf8')
    expect(after).toBe(userYaml)
  })

  it('T24c: 文件已存在 + --force=true → 覆盖 + atomic write', async () => {
    const dir = await makeTmpDir()
    const configDir = dir
    const configPath = path.join(configDir, 'auto.yaml')
    const metaPath = path.join(configDir, 'account-meta.json')

    // 预写旧内容
    await import('node:fs/promises').then(m => m.writeFile(configPath, 'old content'))

    const result = await runAutoInitConfig({ configDir, force: true })

    // 1. 覆盖
    expect(result.created).toBe(true)

    // 2. 内容已替换为模板 (不再含 'old content')
    const after = await readFile(configPath, 'utf8')
    expect(after).not.toBe('old content')
    expect(after.length).toBeGreaterThan(0)
  })

  it('T24d: account-meta.json 字段 = createDefaultAccountMeta (currentTier="new" + blockedHistory=[])', async () => {
    const dir = await makeTmpDir()
    const metaPath = path.join(dir, 'account-meta.json')

    await runAutoInitConfig({ configDir: dir, force: false })

    // 读 + parse
    const raw = await readFile(metaPath, 'utf8')
    const parsed = JSON.parse(raw) as Record<string, unknown>

    // 关键字段 (per §16.3.3 + createDefaultAccountMeta)
    expect(parsed.currentTier).toBe('new')
    expect(parsed.blockedHistory).toEqual([])
    expect(parsed.accountAgeDays).toBe(0)
    expect(parsed.weeklyCap).toBe(500)
    expect(Array.isArray(parsed.warmupSchedule)).toBe(true)
    expect((parsed.warmupSchedule as unknown[]).length).toBe(3)
  })

  it('T24e: auto.yaml 用 AutoConfigSchema safeParse 校验通过 (roundtrip)', async () => {
    const dir = await makeTmpDir()
    const configPath = path.join(dir, 'auto.yaml')

    await runAutoInitConfig({ configDir: dir, force: false })

    // 读 yaml + zod 校验
    const raw = await readFile(configPath, 'utf8')
    const { parse: parseYaml } = await import('yaml')
    const parsed = parseYaml(raw)
    const result = AutoConfigSchema.safeParse(parsed)

    // schema 校验通过
    expect(result.success).toBe(true)

    // 关键字段 (per §16.3.3)
    if (result.success) {
      expect(result.data.version).toBe(1)
      expect(result.data.searches.length).toBeGreaterThanOrEqual(1)
      expect(result.data.searches[0]?.keyword).toBeTruthy()
      expect(result.data.quota.morning).toBe(40)
      expect(result.data.quota.afternoon).toBe(60)
      expect(result.data.throttle.morning_interval_ms[0]).toBe(180000)
    }
  })
})

// ============================================================
// T12: Sprint E-3.x — runAutoInitConfig 不传 configDir → 写项目根 (Q11 A 决策)
// ============================================================
// 行为契约 (per grill-me Q11 A):
//   - 不传 configDir → 内部用 './.bapply-state/' (cwd 相对)
//   - configPath = './auto.yaml' (Q5 A 决策)
//   - metaPath = './.bapply-state/account-meta.json' (Q3b A + Q11 A 合并)
//
// TDD 状态: RED (src 未改, DEFAULT_CONFIG_DIR 仍 '~/.bapply/', metaPath 会是 '/Users/.../.bapply/account-meta.json')

describe('T12: runAutoInitConfig 不传 configDir → 写项目根 (Q11 A)', () => {
  it('T12: configPath = "./auto.yaml" + metaPath = "./.bapply-state/account-meta.json"', async () => {
    // Arrange: chdir 到临时目录 (避免污染真实项目根)
    const tmpDir = await makeTmpDir()
    const originalCwd = process.cwd()
    process.chdir(tmpDir)
    try {
      // Act: 不传 configDir 走 default
      const result = await runAutoInitConfig()

      // Assert: 写项目根路径 (Q11 A 决策)
      // 注: path.join normalize 去掉 './' 前缀, 不强制 (与 metaPath 一致)
      // Q11 v3 A: configPath 也写 .bapply-state/ (4 文件统一)
      expect(result.configPath).toBe('.bapply-state/auto.yaml')
      expect(result.metaPath).toBe('.bapply-state/account-meta.json')
    } finally {
      process.chdir(originalCwd)
      await rm(tmpDir, { recursive: true, force: true })
    }
  })
})