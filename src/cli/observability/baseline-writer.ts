// ============================================================
// baseline-writer — 拦截诊断基线观测（被动）
// ============================================================
// Sprint A — 拦截诊断方案的第一步
//
// 设计动机：
//   诊断 BOSS 直聘行为模式拦截，需要"对照组"——
//   在不引入 --diagnose flag 的常规调用中也默默记一条基线数据，
//   才能对比"诊断模式的拦截率 vs 常态的拦截率"。
//
// 设计原则（参考 §4 设计）：
//   - 零侵入：不改业务逻辑、不增加可见日志、不加重拦截风险
//   - 静默降级：IO 失败时 console.warn，不抛（不能让日志组件挂掉主流程）
//   - 单文件追加：每条记录一行 JSON，按日期分桶
//
// 路径：.claude/diagnose/baseline/<YYYY-MM-DD>.jsonl
// ============================================================

import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'

/** 命令执行状态 */
export type BaselineStatus = 'ok' | 'fail' | 'interrupted'

/** 中断原因（仅当 status === 'interrupted' 或 'fail' 时存在） */
export type InterruptedReason = 'guard_pause' | 'captcha' | 'rate_limit' | 'unknown'

/** 一条基线记录的完整字段 */
export interface BaselineRecord {
  /** ISO 8601 时间戳 */
  ts: string
  /** 命令名：init | login | search | greet | send | chrome */
  command: string
  /** 命令总耗时（毫秒） */
  duration_ms: number
  /** 主请求 HTTP 状态码（无 HTTP 时为 null） */
  http_code: number | null
  /** 结果数（搜索岗位数 / 打招呼数等；不适用时为 0） */
  result_count: number
  /** 执行状态 */
  status: BaselineStatus
  /** 中断原因（可选） */
  interrupted_reason?: InterruptedReason
}

/**
 * 根据 ISO 时间戳计算基线文件路径
 * 文件名格式：YYYY-MM-DD.jsonl（按本地时区分桶，调试期友好）
 */
function getBaselineFilePath(iso: string): string {
  // 取 ISO 字符串前 10 位 YYYY-MM-DD
  // 注：iso 来自 record.ts，是标准 ISO 8601 格式
  const date = iso.slice(0, 10)
  return path.join(process.cwd(), '.claude', 'diagnose', 'baseline', `${date}.jsonl`)
}

/**
 * 确保父目录存在（mkdir -p 语义）
 */
async function ensureDir(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
}

/**
 * 写入一条基线记录（异步版本）
 *
 * 行为契约：
 *   1. 追加写入（不清空文件）
 *   2. 自动创建父目录
 *   3. IO 失败时静默降级：console.warn，不抛异常
 *
 * @param record - 一条基线记录
 */
export async function writeBaselineRecord(record: BaselineRecord): Promise<void> {
  const filePath = getBaselineFilePath(record.ts)
  const line = JSON.stringify(record) + '\n'

  try {
    await ensureDir(filePath)
    await fs.appendFile(filePath, line, 'utf-8')
  } catch (err: unknown) {
    // 降级：不让日志组件挂掉主流程
    const message = err instanceof Error ? err.message : String(err)
    console.warn(`[baseline-writer] 写入失败，降级跳过: ${message}`)
  }
}

/**
 * 写入一条基线记录（同步版本）
 *
 * 使用场景：在 process.exit() 前调用。async 版本会丢（exit 不等 await）。
 * 同步版本保证写入完成才返回，调用方可在 exit 前放心使用。
 *
 * 行为契约：与 async 版本一致，但同步执行。
 *
 * @param record - 一条基线记录
 */
export function writeBaselineRecordSync(record: BaselineRecord): void {
  const filePath = getBaselineFilePath(record.ts)
  const line = JSON.stringify(record) + '\n'

  try {
    fsSync.mkdirSync(path.dirname(filePath), { recursive: true })
    fsSync.appendFileSync(filePath, line, 'utf-8')
  } catch (err: unknown) {
    // 降级：不让日志组件挂掉主流程
    const message = err instanceof Error ? err.message : String(err)
    console.warn(`[baseline-writer] 同步写入失败，降级跳过: ${message}`)
  }
}