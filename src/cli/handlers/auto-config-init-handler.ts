// ============================================================
// src/cli/handlers/auto-config-init-handler.ts — Sprint D-1c §16.5 GREEN
// ------------------------------------------------------------
// 状态: GREEN (per §4.1, RED 已确认 module not found, GREEN 实施落地)
// 覆盖: ADR-0016 §16.3.1 + §16.3.4 + §16.5 D-1c
//   - runAutoInitConfig: 同时生成 auto.yaml + account-meta.json (缺口 4 完整闭环)
//   - POSIX atomic write (复用 §14.8 F1-F5 + D-1b account-meta-store 模式)
//   - --force 覆盖; 否则文件已存在 → skipped='exists' + 0 覆盖 (保护用户数据)
//   - 模板来源: 内联 YAML + createDefaultAccountMeta() (per §16.3.3)
// 纪律: §3.13 错误分层 (AccountMetaError 透传);
//       §3.12 mock 友好 (opts.configDir 注入, 测试用 tmp dir 隔离);
//       §3.10 refactor: 0 改 cli/index.ts (新增 import, 不破旧 9 commands)
// 单账号红线守住: 仅 fs 写模板字符串, 0 触碰 BOSS
// ============================================================

import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import { stringify as yamlStringify } from 'yaml'
import { createDefaultAccountMeta } from '../../auto/account-meta-store'

// ─── opts + result 类型 ──────────────────────────────────────

export interface InitConfigOpts {
  /** config 目录 (默认 ~/.bapply/) */
  configDir?: string
  /** 强制覆盖已存在文件 (默认 false, 保护用户数据) */
  force?: boolean
}

export interface InitConfigResult {
  /** true=本次写入文件, false=文件已存在 + 未传 --force */
  created: boolean
  /** auto.yaml 完整路径 */
  configPath: string
  /** account-meta.json 完整路径 */
  metaPath: string
  /** 仅当 created=false 时存在: 'exists' = 文件已存在未覆盖 */
  skipped?: 'exists'
}

// ─── 模板来源 (per §16.3.3 docs/auto.example.yaml) ────────────

/**
 * 默认 auto.yaml 模板 (per §16.3.3 + §11.5).
 * 与 config-schema.ts 保持一致 (searches 至少 1 项, safety 默认值).
 */
const AUTO_YAML_TEMPLATE = `# bapply auto 配置 — 单账号反爬投递策略
# 详细文档: docs/adr/0016-anti-bot-delivery-strategy.md §11
# 修改后跑 \`bapply auto --dry-run\` 验证不触发 fail-fast

version: 1

# 多轮搜索 (顺序执行, 跨轮去重)
searches:
  - keyword: "Java 后端"
    city: "北京"
    limit: 15

# 时段配额 (per ADR §2: 上午 40 / 下午 60)
quota:
  morning: 40
  afternoon: 60
  weekly_cap: 500

# Warmup 折中 (Day1-7: 50 → Day8-14: 70 → Day15+: 100)
warmup:
  enabled: true
  schedule:
    - { day_start: 1, cap: 50 }
    - { day_start: 8, cap: 70 }
    - { day_start: 15, cap: 100 }

# 节流 (per ADR §2: 上午 180-240s, 下午 150-195s, ±20% jitter)
throttle:
  morning_interval_ms: [180000, 240000]
  afternoon_interval_ms: [150000, 195000]
  jitter_pct: 20
  long_pause: { every_n_jobs: 20, duration_ms: [300000, 600000] }
  afternoon_mid_break: { after_job: 30, duration_ms: [600000, 900000] }

# 风控容错 (per ADR §16 缺口 2 暴露: max_failure_rate 默认 0.3)
safety:
  guard_trigger_policy: 'abort_day'
  max_failure_rate: 0.3
  consecutive_guard_threshold: 3
  auto_regress_warmup: true
`

// ─── 默认路径常量 ────────────────────────────────────────────

const DEFAULT_CONFIG_DIR = './.bapply-state/'  // Q11 A: cwd 相对 (项目根, 与 简历.yml 模式一致)

/** 展开 ~ 为 home dir (与 config-loader 保持一致) */
function expandHome(p: string): string {
  if (p.startsWith('~/')) {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? '/tmp'
    return p.replace('~', home)
  }
  return p
}

// ─── POSIX atomic write helper (per §14.8 F1+F2+F4 复用) ──────

/**
 * 原子化写文件 (tmp + writeFile + sync + rename).
 * 失败时清理 tmp 防泄漏 (per §14.8 F2).
 *
 * @throws Error (写失败时抛, 不吞, 由 caller 决定如何处理)
 */
async function writeAtomic(filepath: string, data: string): Promise<void> {
  const dir = path.dirname(filepath)
  await fsp.mkdir(dir, { recursive: true })  // F4: mkdir -p
  const tmp = `${filepath}.tmp.${process.pid}.${randomUUID()}`  // F1: randomUUID
  const fd = await fsp.open(tmp, 'w')
  try {
    await fd.writeFile(data)
    await fd.sync()  // fsync
  } finally {
    await fd.close()
  }
  try {
    await fsp.rename(tmp, filepath)  // F2: POSIX atomic
  } catch (e) {
    await fsp.rm(tmp, { force: true }).catch(() => { /* best-effort */ })
    throw e
  }
}

// ─── 主入口 ─────────────────────────────────────────────────

/**
 * 同时生成 auto.yaml + account-meta.json (per §16.3.1 架构图 + §16.5 T24).
 *
 * 行为:
 *   1. mkdir -p configDir (F4)
 *   2. 检查 2 文件是否已存在
 *      - 都已存在 + !force → return skipped='exists' + 0 覆盖 (保护用户数据)
 *      - 任一不存在 + !force → 只写不存在的; 已存在的不动
 *      - force=true → 全部覆盖
 *   3. POSIX atomic write (复用 §14.8 F1-F5)
 *   4. 返回 InitConfigResult
 *
 * @example
 *   await runAutoInitConfig({ configDir: '~/.bapply' })
 *   → { created: true, configPath: '~/.bapply/auto.yaml', metaPath: '~/.bapply/account-meta.json' }
 */
export async function runAutoInitConfig(
  opts: InitConfigOpts = {},
): Promise<InitConfigResult> {
  const configDir = expandHome(opts.configDir ?? DEFAULT_CONFIG_DIR)
  // Q11 v3 A: 4 文件统一 .bapply-state/ (auto.yaml + counter + account-meta + cookies)
  // configDir 不传 → 默认 './.bapply-state/' (Q3b A), 写 .bapply-state/auto.yaml
  const configPath = path.join(configDir, 'auto.yaml')
  // Q3b A + Q11 A: account-meta.json 写 state 子目录
  // 注: 不加 './' 前缀 (path.join 自然正确, 避免绝对路径变成 './/var/...' 双斜杠)
  const metaPath = path.join(configDir, 'account-meta.json')
  const force = opts.force ?? false

  // 1. mkdir -p (F4)
  await fsp.mkdir(configDir, { recursive: true })

  // 2. 检查文件存在
  const configExists = await fileExists(configPath)
  const metaExists = await fileExists(metaPath)

  // 3. 任一已存在 + 不强制 → 整体 skipped (保护用户已有数据)
  if ((configExists || metaExists) && !force) {
    return {
      created: false,
      configPath,
      metaPath,
      skipped: 'exists',
    }
  }

  // 4. 写 auto.yaml (不存在 OR force=true)
  if (!configExists || force) {
    await writeAtomic(configPath, AUTO_YAML_TEMPLATE)
  }

  // 5. 写 account-meta.json (不存在 OR force=true)
  if (!metaExists || force) {
    const defaultMeta = createDefaultAccountMeta()
    const json = JSON.stringify(defaultMeta, null, 2)
    await writeAtomic(metaPath, json)
  }

  return { created: true, configPath, metaPath }
}

/** 检查文件是否存在 (ENOENT → false, 其他错误原样抛) */
async function fileExists(filepath: string): Promise<boolean> {
  try {
    await fsp.access(filepath)
    return true
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw e
  }
}