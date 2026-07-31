// ============================================================
// src/auto/config-loader.ts — Sprint D-1a §16.5 GREEN
// ------------------------------------------------------------
// 状态: GREEN (per §4.1, RED 已确认 import 失败, GREEN 实现落地)
// 覆盖: ADR-0016 §11.5 + §16.3.3 D-1a
//   - loadAutoConfig: readFile → yaml.parse → zod validate → defaults → quota split
//   - AutoConfigError (layer='CONFIG') per §3.13
//   - --quota N 比例拆 (缺口 3 修订): dailyCap=N, 按 quota.morning/(morning+afternoon) 拆
//   - safety 默认值合并 (缺口 2): max_failure_rate=0.3
// 纪律: §3.13 错误分层 (cause 链保留); §3.10 refactor: D-1b 才扩展 {config, accountMeta}
// 单账号红线守住: 仅 fs read + yaml parse, 0 触碰 BOSS
// ============================================================

import * as fsp from 'node:fs/promises'
import * as yaml from 'yaml'
import {
  AutoConfigSchema,
  DEFAULT_SAFETY,
  DEFAULT_NOTIFIER,
  type AutoConfig,
} from './config-schema'

// ─── AutoConfigError (per §3.13) ─────────────────────────────

export type AutoConfigErrorCode = 'not_found' | 'yaml_parse' | 'schema_invalid'

/**
 * §16 D-1a + §3.13: 配置加载失败时抛出 (3 种 code).
 * CLI 层 catch 后打印用户友好消息 + process.exit(2).
 *
 * @example
 *   throw new AutoConfigError('not_found', { cause: enoentErr })
 */
export class AutoConfigError extends Error {
  readonly layer = 'CONFIG' as const  // per §3.13

  constructor(
    public code: AutoConfigErrorCode,
    options?: ErrorOptions,
  ) {
    super(`auto_config(${code})`, options)
    this.name = 'AutoConfigError'
  }
}

/** Type guard: 安全识别 AutoConfigError */
export function isAutoConfigError(e: unknown): e is AutoConfigError {
  return e instanceof AutoConfigError
}

// ─── loadAutoConfig opts ─────────────────────────────────────

export interface LoadAutoConfigOpts {
  /** config 文件路径; 默认 ~/.bapply/auto.yaml */
  configPath: string
  /** 任务阶段 (morning | afternoon), 用于 throttle 决策 */
  phase: 'morning' | 'afternoon'
  /** 任务日期 (YYYY-MM-DD) */
  date: string
  /** --quota N: 今天总共 N 条, 比例拆到 morning/afternoon (缺口 3) */
  quotaOverride?: number
  /** --dry-run: 标记 (不真投递, 默认 false) */
  dryRun?: boolean
}

// ─── 默认 config 路径 ────────────────────────────────────────

const DEFAULT_CONFIG_PATH = './.bapply-state/auto.yaml'  // Q11 v3 A: 4 文件统一 .bapply-state/ (e2e 实际, 架构最一致)

/** 展开 ~ 为 home dir */
function expandHome(p: string): string {
  if (p.startsWith('~/')) {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? '/tmp'
    return p.replace('~', home)
  }
  return p
}

// ─── --quota 比例拆 (缺口 3 修订) ────────────────────────────

/**
 * --quota N = 今日总共 N 条 → 按 morning:afternoon 比例拆.
 * 例: quota.morning=40, afternoon=60, --quota 60
 *     → ratio = 40/100 = 0.4
 *     → morning = round(60 × 0.4) = 24
 *     → afternoon = 60 - 24 = 36
 *     → 总和 = 60 ✓
 */
function applyQuotaOverride(
  config: AutoConfig,
  quotaOverride: number | undefined,
): AutoConfig {
  if (quotaOverride === undefined || quotaOverride <= 0) return config

  const { morning, afternoon } = config.quota
  const total = morning + afternoon
  if (total === 0) return config  // 防御: 原配额全 0, 不拆

  const morningRatio = morning / total
  const newMorning = Math.round(quotaOverride * morningRatio)
  const newAfternoon = quotaOverride - newMorning

  return {
    ...config,
    quota: {
      ...config.quota,
      morning: newMorning,
      afternoon: newAfternoon,
    },
  }
}

// ─── 主入口 ─────────────────────────────────────────────────

/**
 * 加载 + 校验 + 默认值合并 + quota 比例拆.
 * @throws AutoConfigError (layer='CONFIG') with code:
 *   - 'not_found'      配置文件不存在 (ENOENT)
 *   - 'yaml_parse'     YAML 语法错 (yaml.YAMLParseError)
 *   - 'schema_invalid' zod 校验失败 (z.ZodError)
 */
export async function loadAutoConfig(
  opts: LoadAutoConfigOpts,
): Promise<{ config: AutoConfig }> {
  const filepath = expandHome(opts.configPath ?? DEFAULT_CONFIG_PATH)

  // 1. 读文件 (per §16.3.2)
  let raw: string
  try {
    raw = await fsp.readFile(filepath, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new AutoConfigError('not_found', { cause: e })
    }
    throw e  // 其他 IO 错 (EACCES, EISDIR 等) 原样抛
  }

  // 2. yaml 解析
  let parsed: unknown
  try {
    parsed = yaml.parse(raw)
  } catch (e) {
    throw new AutoConfigError('yaml_parse', { cause: e })
  }

  // 3. zod 校验
  const result = AutoConfigSchema.safeParse(parsed)
  if (!result.success) {
    throw new AutoConfigError('schema_invalid', { cause: result.error })
  }

  // 4. safety + notifier 默认值合并 (缺口 2 暴露 + E-1b wiring)
  const configWithDefaults: AutoConfig = {
    ...result.data,
    safety: result.data.safety ?? DEFAULT_SAFETY,
    notifier: result.data.notifier ?? DEFAULT_NOTIFIER,
  }

  // 5. --quota 比例拆 (缺口 3 修订)
  const finalConfig = applyQuotaOverride(configWithDefaults, opts.quotaOverride)

  return { config: finalConfig }
}
