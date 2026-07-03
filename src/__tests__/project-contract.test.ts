// ============================================================
// 项目级契约测试：.env.example + docs/ENVIRONMENT.md + README.md
// ============================================================
// P2 #15 — 文档缺口补齐 + 拆分权威职责
//
// 权威职责拆分（避免单一文件双重职责）：
//   - .env.example       → "示例 / 模板"（人类可读，CSP 用）
//   - docs/ENVIRONMENT.md → "权威单文档"（所有变量语义、默认值、优先级的真理）
//   - README.md          → "项目门面"（安装 / 命令 / 门面声明）
// ============================================================

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
/** 项目根：从 src/__tests__/ 向上两级 */
const PROJECT_ROOT = path.resolve(__dirname, '..', '..')

const ENV_EXAMPLE = path.join(PROJECT_ROOT, '.env.example')
const ENV_DOC = path.join(PROJECT_ROOT, 'docs', 'ENVIRONMENT.md')
const README = path.join(PROJECT_ROOT, 'README.md')

// ============================================================
// .env.example — 示例 / 模板（保留向后兼容契约）
// ============================================================

describe('.env.example — 示例 / 模板契约（向后兼容）', () => {
  it('存在', () => {
    expect(fs.existsSync(ENV_EXAMPLE)).toBe(true)
  })

  it('保留 FEISHU_* 变量（向后兼容）', () => {
    const text = fs.readFileSync(ENV_EXAMPLE, 'utf-8')
    expect(text).toContain('FEISHU_APP_ID')
    expect(text).toContain('FEISHU_APP_SECRET')
  })

  it('保留 LLM_PROVIDER 变量', () => {
    const text = fs.readFileSync(ENV_EXAMPLE, 'utf-8')
    expect(text).toContain('LLM_PROVIDER')
  })
})

// ============================================================
// docs/ENVIRONMENT.md — 权威单文档（新增，承担配置语义）
// ============================================================

describe('docs/ENVIRONMENT.md — 权威环境变量文档', () => {
  it('存在', () => {
    expect(fs.existsSync(ENV_DOC)).toBe(true)
  })

  it('明确自我定位为"权威单文档"', () => {
    const text = fs.readFileSync(ENV_DOC, 'utf-8')
    expect(text).toMatch(/权威.+?文档/)
  })

  it('§4.1 覆盖 BOSS_CDP_PORT（含默认值 9222）', () => {
    const text = fs.readFileSync(ENV_DOC, 'utf-8')
    expect(text).toContain('BOSS_CDP_PORT')
    expect(text).toContain('9222')
  })

  it('§4.2 覆盖 BOSS_CHROME_PATH（含平台推断值）', () => {
    const text = fs.readFileSync(ENV_DOC, 'utf-8')
    expect(text).toContain('BOSS_CHROME_PATH')
    // 平台推断值（macOS / Windows / Linux 三平台至少出现 2 个）
    const hasMac = text.includes('macOS')
    const hasWin = text.includes('Windows') || text.includes('win32')
    const hasLinux = text.includes('Linux') || text.includes('linux')
    const platformCount = [hasMac, hasWin, hasLinux].filter(Boolean).length
    expect(platformCount).toBeGreaterThanOrEqual(2)
  })

  it('§6 文档化优先级链（CLI > 环境变量 > 默认）', () => {
    const text = fs.readFileSync(ENV_DOC, 'utf-8')
    expect(text).toContain('CLI')
    expect(text).toContain('环境变量')
  })

  it('文档总行数 ≥ 80（拒绝空壳"权威"）', () => {
    const text = fs.readFileSync(ENV_DOC, 'utf-8')
    expect(text.split('\n').length).toBeGreaterThanOrEqual(80)
  })
})

// ============================================================
// README.md — 项目门面
// ============================================================

describe('README.md — 项目第一触点', () => {
  it('存在', () => {
    expect(fs.existsSync(README)).toBe(true)
  })

  it('包含项目标题（boss-apply 或 BOSS 直聘 或 BOSS）', () => {
    const text = fs.readFileSync(README, 'utf-8')
    expect(text).toMatch(/(boss-apply|BOSS直聘|BOSS)/)
  })

  it('包含"安装"章节', () => {
    const text = fs.readFileSync(README, 'utf-8')
    expect(text).toMatch(/##\s*.*安装/)
  })

  it('包含"快速开始 / 快速上手"章节', () => {
    const text = fs.readFileSync(README, 'utf-8')
    expect(text).toMatch(/##\s*.*快速/)
  })

  it('包含"合规 / Compliance"段落边界声明', () => {
    const text = fs.readFileSync(README, 'utf-8')
    expect(text).toMatch(/(合规|Compliance|授权|个人账号)/)
  })

  it('包含"核心架构"章节', () => {
    const text = fs.readFileSync(README, 'utf-8')
    expect(text).toMatch(/##\s*.*架构/)
  })

  it('README 引用 docs/ENVIRONMENT.md（权威文档指针）', () => {
    const text = fs.readFileSync(README, 'utf-8')
    expect(text).toContain('docs/ENVIRONMENT.md')
  })

  it('README 行数 ≥ 60（质量下限：拒绝空壳）', () => {
    const text = fs.readFileSync(README, 'utf-8')
    expect(text.split('\n').length).toBeGreaterThanOrEqual(60)
  })
})
