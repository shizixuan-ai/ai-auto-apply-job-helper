// ============================================================
// sync-handler — `bapply sync` 命令实现
// ============================================================
// 4 种模式：
//   1. 默认（mode='list'）：读飞书全部记录，按"状态"字段分组输出分布
//   2. 筛选（mode='filter', status='已沟通'）：只输出指定状态的记录
//   3. 更新（mode='update', recordId, status）：单条更新飞书某条记录的"状态"字段
//   4. auto-greet（mode='auto-greet'）：批量生成招呼语 + 调 BOSS 打招呼 + 回写飞书
//
// auto-greet 流程（每个待投递 job）：
//   1. generateGreeting(jobId) → message（默认 fetchJobDetail + LLM）
//   2. runSendCommand({ jobId, message, cdp: false }) → result
//   3. result.action === 'ok' → updateRecord('已投递') + succeeded++
//
// generateGreeting 通过 deps 注入；测试可 mock，生产用默认实现。
//
// 设计原则：
//   - 不抛异常：所有错误转 Result 结构
//   - 缺配置时优雅提示：missing_config 而非 throw
//   - 字段名约定：飞书记录的"状态"字段（中文）
// ============================================================

import { loadConfig } from '../../config/index.js'
import { listRecords, updateRecord } from '../../feishu/index.js'
import { runSendCommand } from './send-handler.js'
import {
  createCDPSession,
  closeBrowserSession,
  fetchJobDetail,
} from '../../browser/index.js'
import { createLLM } from '../../llm/index.js'
import {
  buildGreetingPrompt,
  buildGreetingSystemPrompt,
  buildResumeSummary,
} from '../../template/index.js'

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
  | {
      action: 'auto-greet'
      total: number
      succeeded: number
      failed: number
      errors: Array<{ jobId: string; reason: string }>
      formatted: string
      /** dry-run 模式标记（仅在 auto-greet + dryRun=true 时存在） */
      dryRun?: boolean
      /** dry-run 模式生成的招呼语列表（仅在 dryRun=true 时存在） */
      messages?: Array<{ jobId: string; message: string }>
    }
  | { action: 'missing_config'; reason: string; hint: string }
  | { action: 'invalid_args'; reason: string }
  | { action: 'fail'; reason: string }

/** runSyncCommand 入参 */
export interface SyncCommandOptions {
  mode: 'list' | 'filter' | 'update' | 'auto-greet'
  /** --status <s>：筛选指定状态 */
  status?: string
  /** --update-status <id> <s>：recordId */
  recordId?: string
  /** auto-greet 模式：每日处理上限（默认 5） */
  limit?: number
  /**
   * dry-run 模式（auto-greet only）：
   *   - 仍调 generateGreeting（验证 LLM 输出）
   *   - ❌ 不调 runSendCommand（不发真消息给 BOSS HR）
   *   - ❌ 不调 updateRecord（不改飞书状态）
   * 默认 false
   */
  dryRun?: boolean
}

/**
 * 注入式依赖：测试可替换，生产用真实实现
 * 全部 optional，handler 在缺省时回退到默认实现
 */
export interface SyncCommandDeps {
  /** auto-greet 模式：生成招呼语（默认 fetchJobDetail + LLM） */
  generateGreeting?: (jobId: string) => Promise<string>
}

/** auto-greet 默认 limit */
const AUTO_GREET_DEFAULT_LIMIT = 5

/** 飞书默认页大小（sync 一次性读多点，避免分页） */
const SYNC_PAGE_SIZE = 100

/**
 * 同步飞书记录（按模式分发）
 *
 * @param opts - 命令选项
 * @param deps - 注入式依赖（测试用，生产可省略）
 * @returns SyncResult 结构化结果
 */
export async function runSyncCommand(
  opts: SyncCommandOptions,
  deps: SyncCommandDeps = {},
): Promise<SyncResult> {
  const generateGreetingFn = deps.generateGreeting ?? defaultGenerateGreeting
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

    // ============== auto-greet 模式 ==============
    if (opts.mode === 'auto-greet') {
      const limit = opts.limit ?? AUTO_GREET_DEFAULT_LIMIT
      // 筛选『待投递』+ 应用 limit
      const pending = items
        .filter((it) => String(it.fields['状态'] ?? '') === '待投递')
        .slice(0, limit)

      if (pending.length === 0) {
        return {
          action: 'auto-greet',
          total: 0,
          succeeded: 0,
          failed: 0,
          errors: [],
          formatted: '📭 没有『待投递』状态的岗位，无需打招呼\n\n💡 用 `bapply search` 收集岗位，`bapply greet` 生成话术后 `bapply send` 投递',
          ...(opts.dryRun ? { dryRun: true, messages: [] as Array<{ jobId: string; message: string }> } : {}),
        }
      }

      // 遍历调 BOSS 打招呼
      let succeeded = 0
      let failed = 0
      const errors: Array<{ jobId: string; reason: string }> = []
      // dry-run 专用：收集生成的招呼语（仅 dryRun=true 时使用）
      const dryRunMessages: Array<{ jobId: string; message: string }> = []

      for (const job of pending) {
        const jobId = job.record_id
        // 关键修复（2026-07-07 P0）：generateGreeting 需要 BOSS job_id 而非 Feishu record_id
        // 优先读 fields['BOSS_ID']；缺失时显式报错（不再偷偷拿 record_id 当 BOSS job_id）
        const bossJobId = String(job.fields['BOSS_ID'] ?? '').trim()
        if (!bossJobId) {
          failed++
          errors.push({
            jobId,
            reason:
              '缺少 BOSS_ID 字段。请先用 `bapply search <关键词>` 搜索岗位（自动写 BOSS_ID），再标记为『待投递』',
          })
          continue
        }

        // Sprint 2B Commit 2（2026-07-09）：读 fields['HR_UID']
        //   来源：search-and-write 写入（Sprint 2B Commit 1）
        //   用途：friend/add API 第二参数（BOSS HR 加密 uid）
        //   缺失防护：显式报错 + 不调 generateGreeting（节省 LLM 配额 + 防风控额度浪费）
        const hrUid = String(job.fields['HR_UID'] ?? '').trim()
        if (!hrUid) {
          failed++
          errors.push({
            jobId,
            reason:
              '缺少 HR_UID 字段。请重跑 `bapply search <关键词>`（会自动写 BOSS_ID + HR_UID），再标记为『待投递』',
          })
          continue
        }

        // Step 1: 生成招呼语（B-2b-2 修复：消除 message=undefined → invalid_args bug）
        let message: string
        try {
          message = await generateGreetingFn(bossJobId)
        } catch (err: unknown) {
          failed++
          const msg = err instanceof Error ? err.message : String(err)
          errors.push({ jobId, reason: `生成招呼语失败: ${msg}` })
          continue
        }

        // dry-run 短路：仅记录 message，🚨 不调 runSendCommand、不改飞书
        if (opts.dryRun) {
          dryRunMessages.push({ jobId, message })
          continue
        }

        // Step 2: 发送招呼
        // Sprint 2B Commit 2 修 3 GAP（2026-07-09）：
        //   GAP-A: jobId 必须是 BOSS job_id（encryptJobId）才能调 friend/add
        //   GAP-B: hrUid 从 fields['HR_UID'] 读（不再是 '' 占位）
        //   GAP-C: recordId 必传，让 send-handler 写飞书"打招呼状态/时间"（Sprint 2A.2）
        // Sprint 2026-07-14 / ADR-0007：sync 路径暂时用占位符 + TODO
        //   飞书 schema 待升级（LID/SECURITY_ID 字段 + search-and-write 写入），下个 sprint 处理
        const sendResult = await runSendCommand({
          jobId: bossJobId, // ✅ BOSS job_id（encryptJobId），不是 Feishu record_id
          lid: 'PLACEHOLDER_LID_TODO', // TODO(Sprint C): 从 fields['LID'] 读，飞书 schema 升级后启用
          securityId: 'PLACEHOLDER_SID_TODO', // TODO(Sprint C): 从 fields['SECURITY_ID'] 读，飞书 schema 升级后启用
          recordId: jobId,  // ✅ Feishu record_id（writeback 用）
          cdp: false,
        })

        if (sendResult.action === 'ok') {
          // 成功 → 回写飞书『已投递』
          try {
            await updateRecord(appToken, tableId, jobId, { 状态: '已投递' })
            succeeded++
          } catch (err: unknown) {
            // updateRecord 失败：算半成功，jobId 已打招呼但飞书未更新
            const message = err instanceof Error ? err.message : String(err)
            errors.push({ jobId, reason: `已打招呼但飞书更新失败: ${message}` })
            failed++
          }
        } else {
          // runSendCommand 失败：累积错误，继续下一个
          // （SendCommandResult.action 必有值；reason 必有值，DiscriminatedUnion 已保证）
          failed++
          errors.push({ jobId, reason: sendResult.reason })
        }
      }

      // ============================================================
      // 格式化输出
      // ============================================================
      // dry-run 和正常模式共用同一格式化模板，仅头部 banner 不同
      // ============================================================
      const errorLines = errors.length > 0
        ? ['\n❌ 失败明细:', ...errors.map((e) => `  - ${e.jobId}: ${e.reason}`)]
        : []

      let formatted: string
      if (opts.dryRun) {
        // dry-run：显示生成的招呼语，让用户 review 后再决定真实发送
        const messageLines = dryRunMessages.length > 0
          ? [
              '\n📨 生成的招呼语（DRY RUN，未发送）:',
              ...dryRunMessages.flatMap((m, i) => [
                `  [${i + 1}] jobId=${m.jobId}`,
                `      "${m.message}"`,
              ]),
            ]
          : ['\n📭 无成功生成的招呼语']

        formatted = [
          '🧪 DRY RUN — auto-greet 演练模式',
          '═══════════════════════════════════',
          `总待投递:   ${pending.length}`,
          `📝 已生成:   ${dryRunMessages.length}`,
          `❌ 生成失败: ${errors.length}`,
          ...messageLines,
          ...errorLines,
          '\n💡 确认招呼语质量后，去掉 --dry-run 跑真实发送:',
          '   bapply sync --auto-greet --limit ' + pending.length,
        ].join('\n')
      } else {
        formatted = [
          '🚀 批量打招呼汇总',
          '═══════════════════════',
          `总处理:    ${pending.length}`,
          `✅ 成功:   ${succeeded}`,
          `❌ 失败:   ${failed}`,
          ...errorLines,
          '\n💡 用 `bapply stats` 查看最新投递统计',
        ].join('\n')
      }

      return {
        action: 'auto-greet',
        total: pending.length,
        succeeded,
        failed,
        errors,
        formatted,
        ...(opts.dryRun ? { dryRun: true, messages: dryRunMessages } : {}),
      }
    }

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

// ============================================================
// 默认 generateGreeting 实现（auto-greet 模式使用）
// ============================================================
// 流程：createCDPSession（接管 9222 已登录 Chrome）→ fetchJobDetail → LLM.generate → close
// 2026-07-07 P0 修复：之前用 createBrowserSession(false) 是反逻辑 ——
//   createBrowserSession 启 stealth Chromium 独立 launch，没 cookie 会触发 BOSS _security_check
//   auto-greet 是 batch 模式，**最**应该用 CDP 接管避免反复 new Chrome 窗口
//
// resume 信息目前硬编码（与 CLI greet 命令保持一致）。
// 后续可从 .env 或简历文件读取，PR 时再改。
// ============================================================

async function defaultGenerateGreeting(jobId: string): Promise<string> {
  const config = loadConfig()
  // P0 fix: 用 CDP 接管已登录 Chrome（保留 BOSS session cookie）
  const session = await createCDPSession()
  try {
    const jd = await fetchJobDetail(session.page, jobId)
    const resumeSummary = buildResumeSummary({
      skills: ['TypeScript', 'React', 'Node.js'],
      yearsOfExperience: 3,
      education: '本科',
    })
    const llm = createLLM(config)
    return await llm.generate(
      buildGreetingPrompt(jd, resumeSummary),
      buildGreetingSystemPrompt(),
    )
  } finally {
    await closeBrowserSession(session)
  }
}