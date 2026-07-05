// ============================================================
// list-handler — `bapply list` 命令实现
// ============================================================
// Sprint B-2a：CLI handler 落地
//
// 设计动机：现有 cli/index.ts 中 list 命令完全缺失（PRD 缺 3 个命令之一）
// 职责：
//   - 调 listRecords 拉飞书多维表格记录
//   - 格式化为人类可读文本
//   - 返回结构化结果，由 CLI 层决定 exit code
//
// 设计原则（参考 §3）：
//   - 不抛异常：所有错误转 Result 结构，CLI 层决定如何报告
//   - 缺配置时优雅提示：空字符串 appToken/tableId → 返回 missing_config 而非 throw
//   - 测试友好：纯函数式 result，无副作用
// ============================================================

import { loadConfig } from '../../config/index.js'
import { listRecords } from '../../feishu/index.js'

/** runListCommand 返回结果 */
export type ListResult =
  | { action: 'ok'; recordCount: number; formatted: string }
  | { action: 'missing_config'; reason: string; hint: string }
  | { action: 'fail'; reason: string }

/** runListCommand 入参 */
export interface ListCommandOptions {
  /** 每页条数（默认 20） */
  limit: number
}

/**
 * 列出飞书多维表格中的岗位记录（格式化输出）
 *
 * @param opts - 命令选项
 * @returns ListResult 结构化结果
 */
export async function runListCommand(opts: ListCommandOptions): Promise<ListResult> {
  const config = loadConfig()
  const appToken = config.feishu.appToken ?? ''
  const tableId = config.feishu.tableId ?? ''

  // 缺配置：友好提示而非抛错
  if (!appToken || !tableId) {
    return {
      action: 'missing_config',
      reason: 'FEISHU_APP_TOKEN 和 FEISHU_TABLE_ID 未配置',
      hint: '请在 .env 中填充这两个变量后重试。参考 .env.example 或 docs/ENVIRONMENT.md。',
    }
  }

  try {
    const res = await listRecords(appToken, tableId, opts.limit)
    const items = (res as any).data?.items ?? []

    // 空列表
    if (items.length === 0) {
      return {
        action: 'ok',
        recordCount: 0,
        formatted: '📭 多维表格中暂无岗位记录\n\n💡 先跑 `bapply search <关键词>` 把岗位搜出来',
      }
    }

    // 格式化输出
    const lines = items.map((item: any, i: number) => formatRecord(item, i + 1))
    const formatted = `📋 共 ${items.length} 个岗位:\n\n${lines.join('\n')}`

    return {
      action: 'ok',
      recordCount: items.length,
      formatted,
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      action: 'fail',
      reason: `飞书 API 调用失败: ${message}`,
    }
  }
}

/**
 * 格式化单条记录为人类可读文本
 */
function formatRecord(record: { record_id: string; fields: Record<string, unknown> }, index: number): string {
  const f = record.fields
  const 职位 = String(f['职位'] ?? f['岗位'] ?? '?')
  const 公司 = String(f['公司'] ?? f['公司名称'] ?? '?')
  const 薪资 = f['薪资'] ? `  |  薪资: ${f['薪资']}` : ''
  const 城市 = f['城市'] ? `  |  城市: ${f['城市']}` : ''
  const 状态 = f['状态'] ? `  |  状态: ${f['状态']}` : ''
  return `  ${index}. ${职位}\n     公司: ${公司}${薪资}${城市}${状态}`
}