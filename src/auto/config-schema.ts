// ============================================================
// src/auto/config-schema.ts — Sprint D-1a §16.5 GREEN
// ------------------------------------------------------------
// 状态: GREEN (per §4.1, RED 已确认 module 不存在, 5 import failed)
// 覆盖: ADR-0016 §11.2 + §16.3.3 D-1a (AutoConfig zod schema)
//       + §16.1 缺口 2 (safety.max_failure_rate 暴露)
// 纪律: §3.13 错误分层 (zod 错误 throw 上抛, AutoConfigError wrap);
//       §3.12 mock 友好 (zod 默认值合并可选, 测试可注)
// 单账号红线守住: 仅 schema 定义, 0 触碰 BOSS
// ============================================================

import { z } from 'zod'

// ─── 子 schema ───────────────────────────────────────────────

/** §11.2 SearchEntry: keyword 必填, city/jobType/salary/experience/degree 可选 */
export const SearchEntrySchema = z.object({
  keyword: z.string().min(1, 'keyword 不能为空'),
  city: z.string().optional(),
  jobType: z.string().optional(),     // BOSS 码 (e.g. 1901)
  salary: z.string().optional(),       // BOSS 码 (e.g. 406)
  experience: z.string().optional(),   // BOSS 码 (e.g. 106)
  degree: z.string().optional(),       // BOSS 码 (e.g. 203)
  limit: z.number().int().positive().optional(),
})

/** §11.2 QuotaConfig: morning/afternoon 必填, weekly_cap 必填 */
export const QuotaConfigSchema = z.object({
  morning: z.number().int().nonnegative(),
  afternoon: z.number().int().nonnegative(),
  weekly_cap: z.number().int().positive(),
})

/** §11.2 WarmupConfig (可选): enabled + schedule */
export const WarmupConfigSchema = z.object({
  enabled: z.boolean(),
  schedule: z.array(z.object({
    day_start: z.number().int().positive(),
    cap: z.number().int().positive(),
  })),
})

/** §11.2 ThrottleConfig */
export const ThrottleConfigSchema = z.object({
  morning_interval_ms: z.tuple([z.number().int().nonnegative(), z.number().int().positive()]),
  afternoon_interval_ms: z.tuple([z.number().int().nonnegative(), z.number().int().positive()]),
  jitter_pct: z.number().min(0).max(100),
  long_pause: z.object({
    every_n_jobs: z.number().int().positive(),
    duration_ms: z.tuple([z.number().int().nonnegative(), z.number().int().positive()]),
  }),
  afternoon_mid_break: z.object({
    after_job: z.number().int().positive(),
    duration_ms: z.tuple([z.number().int().nonnegative(), z.number().int().positive()]),
  }),
})

/** §16.3.3 SafetyConfig: 暴露 max_failure_rate (缺口 2) + 降档策略 */
export const SafetyConfigSchema = z.object({
  guard_trigger_policy: z.enum(['abort_day', 'abort_run', 'continue']),
  max_failure_rate: z.number().min(0).max(1),                       // 默认 0.3 (per R3)
  consecutive_guard_threshold: z.number().int().positive(),         // 默认 3
  auto_regress_warmup: z.boolean(),                                  // 默认 true
})

// ─── 主 schema ───────────────────────────────────────────────

export const AutoConfigSchema = z.object({
  version: z.literal(1),
  searches: z.array(SearchEntrySchema).min(1, 'searches[] 至少 1 项'),  // per §11.5
  quota: QuotaConfigSchema,
  warmup: WarmupConfigSchema.optional(),
  throttle: ThrottleConfigSchema,
  safety: SafetyConfigSchema.optional(),                              // 缺 → 默认合并
})

// ─── TS 类型导出 ─────────────────────────────────────────────

export type SearchEntry = z.infer<typeof SearchEntrySchema>
export type QuotaConfig = z.infer<typeof QuotaConfigSchema>
export type WarmupConfig = z.infer<typeof WarmupConfigSchema>
export type ThrottleConfig = z.infer<typeof ThrottleConfigSchema>
export type SafetyConfig = z.infer<typeof SafetyConfigSchema>
export type AutoConfig = z.infer<typeof AutoConfigSchema>

// ─── 默认值常量 (per §16.1 缺口 2) ───────────────────────────

/** 默认 safety 节点 (per §16.3.3 + R3) */
export const DEFAULT_SAFETY: SafetyConfig = {
  guard_trigger_policy: 'abort_day',
  max_failure_rate: 0.3,           // per R3 失败率阈值
  consecutive_guard_threshold: 3,  // per §2
  auto_regress_warmup: true,       // per §16.3.3
}

/** zod 主 schema (测试用 export) */
export const configSchema = AutoConfigSchema
