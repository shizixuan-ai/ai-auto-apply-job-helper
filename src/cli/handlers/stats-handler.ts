// ============================================================
// stats-handler — `bapply stats` 命令实现
// ============================================================
// Sprint B-2c：投递统计命令（MVP）
//
// 设计动机：补完 PRD 最后一个 CLI 命令。
// 与 sync 的 list 模式区别：sync 按状态分组输出，stats 输出投递漏斗 +
// 转化率 + Top 公司等多维度聚合视图。
//
// 输出维度（MVP）：
//   - 总数
//   - 状态分布（按数量降序）
//   - 投递率 = (已投递 + 已沟通) / 总数
//   - 沟通率 = 已沟通 / (已投递 + 已沟通)
//   - Top 5 公司
//
// 设计原则：与 list/sync 一致
//   - 不抛异常：所有错误转 Result 结构
//   - 缺配置时优雅提示
// ============================================================

import { loadConfig } from '../../config/index.js'
import { listRecords } from '../../feishu/index.js'

/** 公司计数 */
export interface CompanyCount {
  公司: string
  count: number
}

/** runStatsCommand 返回结果 */
export type StatsResult =
  | {
      action: 'ok'
      totalCount: number
      distribution: Record<string, number>
      topCompanies: CompanyCount[]
      applyRate: number
      replyRate: number
      formatted: string
    }
  | { action: 'missing_config'; reason: string; hint: string }
  | { action: 'fail'; reason: string }

/** runStatsCommand 入参（预留扩展） */
export interface StatsCommandOptions {
  /** 未来：--top <n> 控制 Top 公司数量，默认 5 */
  topN?: number
}

/** 飞书默认页大小 */
const STATS_PAGE_SIZE = 100

/** Top N 默认值 */
const DEFAULT_TOP_N = 5

/**
 * 聚合统计飞书记录
 *
 * @param opts - 命令选项
 * @returns StatsResult 结构化结果
 */
export async function runStatsCommand(opts: StatsCommandOptions = {}): Promise<StatsResult> {
  const config = loadConfig()
  const appToken = config.feishu.appToken ?? ''
  const tableId = config.feishu.tableId ?? ''

  if (!appToken || !tableId) {
    return {
      action: 'missing_config',
      reason: 'FEISHU_APP_TOKEN 和 FEISHU_TABLE_ID 未配置',
      hint: '请在 .env 中填充这两个变量后重试。参考 .env.example 或 docs/ENVIRONMENT.md。',
    }
  }

  let items: Array<{ record_id: string; fields: Record<string, unknown> }>
  try {
    const res = await listRecords(appToken, tableId, STATS_PAGE_SIZE)
    items = ((res as any).data?.items ?? []) as Array<{
      record_id: string
      fields: Record<string, unknown>
    }>
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return { action: 'fail', reason: `飞书 listRecords 失败: ${message}` }
  }

  // 空记录
  if (items.length === 0) {
    return {
      action: 'ok',
      totalCount: 0,
      distribution: {},
      topCompanies: [],
      applyRate: 0,
      replyRate: 0,
      formatted: '📊 暂无统计数据\n\n💡 先跑 `bapply search <关键词>` 收集岗位，再用 `bapply send` 打招呼',
    }
  }

  // 状态分布
  const distribution: Record<string, number> = {}
  // 公司计数
  const companyCount = new Map<string, number>()

  for (const it of items) {
    const status = String(it.fields['状态'] ?? '未分类')
    distribution[status] = (distribution[status] ?? 0) + 1

    const company = String(it.fields['公司'] ?? it.fields['公司名称'] ?? '未知')
    companyCount.set(company, (companyCount.get(company) ?? 0) + 1)
  }

  // 漏斗百分比
  // 投递率 = 已投递 + 已沟通 / 总数
  const applied = (distribution['已投递'] ?? 0) + (distribution['已沟通'] ?? 0)
  const applyRate = items.length === 0 ? 0 : applied / items.length
  // 沟通率 = 已沟通 / (已投递 + 已沟通)
  const replied = distribution['已沟通'] ?? 0
  const replyRate = applied === 0 ? 0 : replied / applied

  // Top N 公司（按 count 降序，count 相同按公司名升序）
  const topN = opts.topN ?? DEFAULT_TOP_N
  const topCompanies: CompanyCount[] = Array.from(companyCount.entries())
    .map(([公司, count]) => ({ 公司, count }))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count
      return a.公司.localeCompare(b.公司, 'zh-CN')
    })
    .slice(0, topN)

  // 格式化输出
  const distLines = Object.entries(distribution)
    .sort((a, b) => b[1] - a[1])
    .map(([status, count]) => {
      const pct = ((count / items.length) * 100).toFixed(0)
      return `  ${status.padEnd(8)} ${String(count).padStart(3)}  (${pct}%)`
    })

  const topLines = topCompanies.map((c, i) => `  ${i + 1}. ${c.公司.padEnd(8)} ${c.count}`)

  const formatted = [
    '📊 投递统计概览',
    '═══════════════════════',
    `总岗位数:    ${items.length}`,
    '',
    '🎯 投递漏斗:',
    ...distLines,
    '',
    `📈 投递率:    ${(applyRate * 100).toFixed(0)}%  (${applied}/${items.length} 已投递或已沟通)`,
    `💬 沟通率:    ${(replyRate * 100).toFixed(0)}%  (${replied}/${applied} 已投递中已沟通)`,
    '',
    `🏢 Top ${topCompanies.length} 公司:`,
    ...topLines,
    '',
    '💡 用 `bapply list` 查看具体岗位',
    '💡 用 `bapply sync` 更新单条状态',
  ].join('\n')

  return {
    action: 'ok',
    totalCount: items.length,
    distribution,
    topCompanies,
    applyRate,
    replyRate,
    formatted,
  }
}