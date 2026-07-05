// ============================================================
// sync-handler — `bapply sync` 命令实现
// ============================================================
// Sprint B-2b：sync 命令 MVP
//
// 设计动机：把 PRD 缺的 sync 命令实装。MVP 聚焦"读飞书 + 单条手动更新"，
// 真正的 BOSS 自动同步留给后续 sprint。
//
// 三种模式：
//   1. 默认（mode='list'）：读飞书全部记录，按"状态"字段分组输出分布
//   2. 筛选（mode='filter', status='已沟通'）：只输出指定状态的记录
//   3. 更新（mode='update', recordId, status）：单条更新飞书某条记录的"状态"字段
//
// 设计原则：
//   - 不抛异常：所有错误转 Result 结构
//   - 缺配置时优雅提示：missing_config 而非 throw
//   - 字段名约定：飞书记录的"状态"字段（中文）
// ============================================================

import { loadConfig } from '../../config/index.js'
import { listRecords, updateRecord } from '../../feishu/index.js'

/** 飞书记录中"状态"字段的合法值 */
export type SyncStatus = '待投递' | '已投递' | '已沟通' | '不合适' | string

/** runSyncCommand 返回结果 */
export type SyncResult =
  | {
      action: 'list'
      totalCount: number
      distribution: Record<string, number>
      formatted: string
    }
  | { action: 'ok'; recordId: string; status: string }
  | { action: 'missing_config'; reason: string; hint: string }
  | { action: 'invalid_args'; reason: string }
  | { action: 'fail'; reason: string }

/** runSyncCommand 入参 */
export interface SyncCommandOptions {
  mode: 'list' | 'filter' | 'update'
  /** --status <s>：筛选指定状态 */
  status?: string
  /** --update-status <id> <s>：recordId */
  recordId?: string
}

/** 飞书默认页大小（sync 一次性读多点，避免分页） */
const SYNC_PAGE_SIZE = 100

/**
 * 同步飞书记录（按模式分发）
 *
 * @param opts - 命令选项
 * @returns SyncResult 结构化结果
 */
export async function runSyncCommand(opts: SyncCommandOptions): Promise<SyncResult> {
  const config = loadConfig()
  const appToken = config.feishu.appToken ?? ''
  const tableId = config.feishu.tableId ?? ''

  // 缺配置：任何模式都受影响
  if (!appToken || !tableId) {
    return {
      action: 'missing_config',
      reason: 'FEISHU_APP_TOKEN 和 FEISHU_TABLE_ID 未配置',
      hint: '请在 .env 中填充这两个变量后重试。参考 .env.example 或 docs/ENVIRONMENT.md。',
    }
  }

  // ============== update 模式 ==============
  if (opts.mode === 'update') {
    if (!opts.recordId) {
      return { action: 'invalid_args', reason: '缺少 --update-status 的 recordId 参数' }
    }
    if (!opts.status) {
      return { action: 'invalid_args', reason: '缺少 --update-status 的 status 参数' }
    }
    try {
      await updateRecord(appToken, tableId, opts.recordId, { 状态: opts.status })
      return {
        action: 'ok',
        recordId: opts.recordId,
        status: opts.status,
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return { action: 'fail', reason: `飞书 updateRecord 失败: ${message}` }
    }
  }

  // ============== list / filter 模式 ==============
  try {
    const res = await listRecords(appToken, tableId, SYNC_PAGE_SIZE)
    const items = ((res as any).data?.items ?? []) as Array<{
      record_id: string
      fields: Record<string, unknown>
    }>

    // filter 模式：内存中按 status 字段筛选
    const filtered =
      opts.mode === 'filter' && opts.status
        ? items.filter((it) => String(it.fields['状态'] ?? '') === opts.status)
        : items

    // 列表为空
    if (filtered.length === 0) {
      return {
        action: 'list',
        totalCount: 0,
        distribution: {},
        formatted:
          opts.mode === 'filter'
            ? `📭 没有「${opts.status}」状态的岗位\n\n💡 先跑 \`bapply search <关键词>\` 收集岗位，再用 \`bapply send\` 打招呼`
            : '📭 多维表格中暂无岗位记录\n\n💡 先跑 `bapply search <关键词>` 收集岗位',
      }
    }

    // 按状态分组聚合
    const distribution: Record<string, number> = {}
    for (const it of filtered) {
      const status = String(it.fields['状态'] ?? '未分类')
      distribution[status] = (distribution[status] ?? 0) + 1
    }

    // 格式化输出
    let formatted: string
    if (opts.mode === 'filter') {
      // filter 模式：列出每条记录
      const lines = filtered.map((it, i) => {
        const f = it.fields
        return `  ${i + 1}. ${String(f['职位'] ?? f['岗位'] ?? '?')} @ ${String(f['公司'] ?? '?')} [${String(f['状态'] ?? '?')}]`
      })
      formatted = `🔍 「${opts.status}」状态的 ${filtered.length} 个岗位:\n\n${lines.join('\n')}`
    } else {
      // 默认模式：状态分布报告
      const distLines = Object.entries(distribution)
        .sort((a, b) => b[1] - a[1])
        .map(([status, count]) => `  ${status}: ${count}`)
      formatted = `📊 投递状态分布（共 ${items.length} 个岗位）:\n\n${distLines.join('\n')}\n\n💡 用 \`bapply sync --status <状态>\` 查看具体岗位\n💡 用 \`bapply sync --update-status <recordId> <新状态>\` 更新单条`
    }

    return {
      action: 'list',
      totalCount: filtered.length,
      distribution,
      formatted,
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return { action: 'fail', reason: `飞书 listRecords 失败: ${message}` }
  }
}