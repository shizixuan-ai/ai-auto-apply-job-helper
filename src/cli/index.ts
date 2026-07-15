#!/usr/bin/env node

// ============================================================
// CLI 入口 — commander
// ============================================================
// 命令: init | login | search | greet | send
// ============================================================

import { Command } from 'commander'
import chalk from 'chalk'
import readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { loadConfig } from '../config/index.js'
import { createBrowserSession, createCDPSession, closeBrowserSession, loginByQR, searchJobs, fetchJobDetail, sendGreeting, setWaitForUserConfirm } from '../browser/index.js'
import { createLLM } from '../llm/index.js'
import { buildGreetingSystemPrompt, buildGreetingPrompt, buildResumeSummary } from '../template/index.js'
import { listRecords, createRecord, updateRecord } from '../feishu/index.js'
import { handleChromeCommand } from './handlers/chrome-handler.js'
import { runSendCommand, type SendCommandResult } from './handlers/send-handler.js'
import { runListCommand, type ListResult } from './handlers/list-handler.js'
import { runSyncCommand, type SyncResult } from './handlers/sync-handler.js'
import { runStatsCommand, type StatsResult } from './handlers/stats-handler.js'
import { writeBaselineRecord, writeBaselineRecordSync, type BaselineRecord } from './observability/baseline-writer.js'

/** SendCommandResult.action → process.exit code 映射（doc-only，CLI 层 switch 用） */
const SEND_EXIT_CODE: Record<SendCommandResult['action'], number> = {
  ok: 0,
  failed: 1,
  invalid_args: 2,
  abort_today: 3,
  abort: 4,
}

/** ListResult.action → process.exit code 映射 */
const LIST_EXIT_CODE: Record<ListResult['action'], number> = {
  ok: 0,
  missing_config: 2, // 类比 send.invalid_args：缺配置也算"参数错"
  fail: 1,
}

/** SyncResult.action → process.exit code 映射 */
const SYNC_EXIT_CODE: Record<SyncResult['action'], number> = {
  ok: 0,
  list: 0,
  'auto-greet': 0, // 部分成功也算 ok（退出码），失败明细在 errors
  missing_config: 2,
  invalid_args: 2,
  fail: 1,
}

/** StatsResult.action → process.exit code 映射 */
const STATS_EXIT_CODE: Record<StatsResult['action'], number> = {
  ok: 0,
  missing_config: 2,
  fail: 1,
}

const program = new Command()

/**
 * 注入 guard.ts 的用户确认 prompt：风控触发时让用户按回车恢复
 */
setWaitForUserConfirm(async () => {
  const rl = readline.createInterface({ input, output })
  try {
    await rl.question(chalk.yellow('✅ 风控验证完成后，按回车继续…'))
  } finally {
    rl.close()
  }
})

/** 根据模式创建浏览器会话 */
async function createSession(cdp = false) {
  return cdp ? createCDPSession() : createBrowserSession(false)
}

program
  .name('bapply')
  .description('AI 自动投递简历辅助工具 — BOSS 直聘')
  .version('0.1.0')
  .option('--cdp', '连接已有 Chrome（通过 CDP，绕过反爬）', false)

// ============================================================
// init
// ============================================================

program
  .command('init')
  .description('检查环境配置是否正确')
  .action(async () => {
    const start = Date.now()
    let status: BaselineRecord['status'] = 'ok'
    console.log(chalk.cyan('🔍 正在检查配置...\n'))

    try {
      const config = loadConfig()
      console.log(chalk.green('✅ 环境变量加载成功'))
      console.log(`   飞书 App ID: ${config.feishu.appId.slice(0, 8)}...`)
      console.log(`   LLM 供应商: ${config.llm.provider}`)
      console.log()
      console.log(chalk.cyan('🔍 检查飞书 API 连通性...'))

      await listRecords('test', 'test')
      console.log(chalk.green('✅ 飞书 API 连通正常'))
    } catch (err: any) {
      status = 'fail'
      const msg = err instanceof Error ? err.message : String(err)

      // 审计修复（穷尽审计 P1-2）：区分认证/权限/限流/网络错误
      // 用户填错 APP_SECRET 时不再笼统提示，需具体指引
      if (/code=99991/.test(msg) || msg.includes('invalid') || msg.includes('unauthorized')) {
        console.log(chalk.red('❌ 飞书认证失败'))
        console.log(chalk.yellow('   请检查 FEISHU_APP_ID 和 FEISHU_APP_SECRET 是否正确'))
        console.log(chalk.yellow('   获取地址: https://open.feishu.cn/app'))
      } else if (msg.includes('code=91402') || msg.includes('NOTEXIST') || msg.includes('not found')) {
        console.log(chalk.red('❌ 飞书表格不存在'))
        console.log(chalk.yellow('   请检查 FEISHU_APP_TOKEN 和 FEISHU_TABLE_ID 是否正确'))
        console.log(chalk.yellow('   从多维表格 URL 末尾获取: /base/<APP_TOKEN>?table=<TABLE_ID>'))
      } else if (msg.includes('code=99991') || msg.includes('rate limit') || msg.includes('429')) {
        console.log(chalk.red('❌ 飞书 API 限流'))
        console.log(chalk.yellow('   请稍后再试，或检查应用权限'))
      } else if (msg.includes('权限') || msg.includes('permission') || msg.includes('forbidden')) {
        console.log(chalk.red('❌ 飞书权限不足'))
        console.log(chalk.yellow('   请在飞书开放平台为应用添加「多维表格」读写权限'))
      } else {
        console.log(chalk.red(`❌ ${msg}`))
      }
      // process.exit(1) 不等 async finally，必须同步写
      writeBaselineRecordSync({
        ts: new Date().toISOString(),
        command: 'init',
        duration_ms: Date.now() - start,
        http_code: null,
        result_count: 0,
        status,
      })
      process.exit(1)
    } finally {
      // 正常退出路径（finally 内的 async writeBaselineRecord 由 commander 等）
      // 失败路径已在 catch 内同步写入，无需重复
      if (status === 'ok') {
        await writeBaselineRecord({
          ts: new Date().toISOString(),
          command: 'init',
          duration_ms: Date.now() - start,
          http_code: null,
          result_count: 0,
          status,
        })
      }
    }
  })

// ============================================================
// login
// ============================================================

program
  .command('login')
  .description('扫码登录 BOSS 直聘（持久化 Cookie）')
  .option('--cdp', '通过 CDP 连接已有 Chrome')
  .action(async (options: { cdp?: boolean }) => {
    const start = Date.now()
    let status: BaselineRecord['status'] = 'ok'
    const cdp = options.cdp ?? program.opts().cdp ?? false
    const session = await createSession(cdp)
    const page = session.page

    try {
      await loginByQR(page)
    } catch (err: any) {
      status = 'fail'
      throw err
    } finally {
      await closeBrowserSession(session)
      await writeBaselineRecord({
        ts: new Date().toISOString(),
        command: 'login',
        duration_ms: Date.now() - start,
        http_code: null,
        result_count: 0,
        status,
      })
    }
  })

// ============================================================
// search
// ============================================================

program
  .command('search')
  .description('搜索岗位并展示列表（加 --write 进入 LLM 评分 + 写飞书模式）')
  .argument('<keyword>', '搜索关键词，如 "前端开发"')
  .option('-c, --city <city>', '城市，如 "北京"')
  .option('--headless', '无头模式运行', false)
  .option('--cdp', '通过 CDP 连接已有 Chrome')
  // ===== Sprint 1A 引入 =====
  .option('--write', '真写飞书（不传 = 仅展示；与 --dry-run 互斥）', false)
  .option('--dry-run', '走完整流程但 createRecord 是 no-op', false)
  .option('--no-threshold', '不过滤（所有 scored 都算 passed，不写 BOSS）')
  .option('-l, --limit <n>', '最多处理 N 个岗位', (v) => Number(v), 10)
  .action(async (keyword: string, options: {
    city?: string
    headless: boolean
    cdp?: boolean
    write: boolean
    dryRun: boolean
    threshold: boolean      // commander 自动从 --no-threshold 派生
    limit: number
  }) => {
    const start = Date.now()
    let status: BaselineRecord['status'] = 'ok'
    let resultCount = 0
    const cdp = options.cdp ?? program.opts().cdp ?? false

    // ===== Sprint 1A: --write / --dry-run 模式 =====
    if (options.write || options.dryRun) {
      if (options.write && options.dryRun) {
        console.error(chalk.red('❌ --write 与 --dry-run 互斥，只能二选一'))
        process.exit(2)
      }

      // 走 runSearchAndWrite 流程
      const config = loadConfig()
      // 写飞书前必须配 appToken/tableId（用 ?? 提供 fallback 让 TS narrow）
      const appToken = config.feishu.appToken ?? ''
      const tableId = config.feishu.tableId ?? ''
      if (!appToken || !tableId) {
        console.error(chalk.red('❌ --write / --dry-run 需要 FEISHU_APP_TOKEN 和 FEISHU_TABLE_ID（参考 .env.example）'))
        process.exit(2)
      }
      const session = cdp
        ? await createCDPSession()
        : await createBrowserSession(!options.headless)
      const page = session.page

      try {
        // 1) 搜索
        const jobs = await searchJobs(page, keyword, options.city)
        resultCount = jobs.length

        // 2) 构造 deps
        const llm = createLLM(config)
        const { resolveResume } = await import('../resume/resolver.js')
        const { scoreJob } = await import('../scoring/index.js')

        const deps = {
          searchJobs: async (_k: string, _c?: string) => jobs,   // 复用上面的搜索结果
          fetchJobDetail: (id: string, ctx?: { lid?: string; securityId?: string }) => fetchJobDetail(page, id, ctx),
          scoreJob: (jd: string, summary: any, _llm: unknown) => scoreJob(jd, summary, llm),
          createRecord: async (fields: any) => {
            // dryRun 走 no-op；write 走真写
            if (options.dryRun) return { record_id: 'dry-run-noop' }
            return createRecord(appToken, tableId, fields)
          },
          resolveResume: () => resolveResume(),
          llm,
          threshold: config.scoreThreshold,
        }

        // 3) 调 handler
        const { runSearchAndWrite } = await import('../cli/handlers/search-and-write.js')
        const result = await runSearchAndWrite(
          {
            keyword,
            city: options.city,
            write: options.write,        // dryRun 模式 opts.write = false
            dryRun: options.dryRun,
            noThreshold: options.threshold === false,
            limit: options.limit,
          },
          deps,
        )

        // 4) 打印报告
        if (result.action === 'error') {
          console.error(chalk.red(`❌ ${result.error}`))
          status = 'fail'
          process.exit(1)
        }

        console.log(chalk.cyan(`\n📊 搜索并评分结果 (mode=${options.write ? 'WRITE' : 'DRY-RUN'}):\n`))
        console.log(`  总岗位: ${chalk.bold(result.total)}`)
        console.log(`  评分成功: ${chalk.bold(result.scored)}`)
        console.log(`  通过阈值 (${config.scoreThreshold}): ${chalk.green(result.passed)}`)
        console.log(`  写入飞书: ${chalk.green(result.written)}`)
        console.log(`  失败: ${chalk.red(result.failed)}`)
        console.log(`  简历来源: ${result.resumeSource}`)
        if (result.resumeWarnings.length) {
          console.log(`  ${chalk.yellow('⚠️ 警告：')}`)
          result.resumeWarnings.forEach((w) => console.log(`    - ${w}`))
        }
        if (options.dryRun) {
          console.log(chalk.yellow(`\n💡 提示：当前是 --dry-run 模式，没真写飞书。加 --write 真写。`))
        }
      } catch (err: any) {
        status = 'fail'
        throw err
      } finally {
        await closeBrowserSession(session)
        await writeBaselineRecord({
          ts: new Date().toISOString(),
          command: options.write ? 'search-write' : 'search-dry-run',
          duration_ms: Date.now() - start,
          http_code: null,
          result_count: resultCount,
          status,
        })
      }
      return
    }

    // ===== 老逻辑：纯展示（无 --write / --dry-run）=====
    const session = cdp
      ? await createCDPSession()
      : await createBrowserSession(!options.headless)
    const page = session.page

    try {
      const jobs = await searchJobs(page, keyword, options.city)
      resultCount = jobs.length

      console.log(chalk.cyan(`\n📋 共找到 ${jobs.length} 个岗位:\n`))
      jobs.forEach((job, i) => {
        console.log(`  ${chalk.yellow(`${i + 1}.`)} ${chalk.bold(job.title)}`)
        console.log(`     公司: ${job.company}  |  薪资: ${job.salary}  |  城市: ${job.city}`)
        if (job.experience) console.log(`     经验: ${job.experience}  |  学历: ${job.degree}`)
        if (job.labels.length) console.log(`     标签: ${job.labels.join('、')}`)
        if (job.brandStage) console.log(`     阶段: ${job.brandStage}  |  规模: ${job.brandScale}  |  行业: ${job.brandIndustry}`)
        if (job.welfare.length) console.log(`     福利: ${job.welfare.join('、')}`)
        console.log()
      })
    } catch (err: any) {
      status = 'fail'
      throw err
    } finally {
      await closeBrowserSession(session)
      await writeBaselineRecord({
        ts: new Date().toISOString(),
        command: 'search',
        duration_ms: Date.now() - start,
        http_code: null,
        result_count: resultCount,
        status,
      })
    }
  })

// ============================================================
// greet
// ============================================================

program
  .command('greet')
  .description('为岗位生成打招呼话术（需先 search 获取 ID）')
  .argument('<jobId>', '岗位 ID（encryptJobId）')
  .option('--headless', '无头模式运行', true)
  .option('--cdp', '通过 CDP 连接已有 Chrome')
  // Sprint 2026-07-14 / task #34：加 lid/securityId 选项
  //   原因：fetchJobDetail 优先走 card.json wapi（需要 lid + securityId）
  //   greet 是独立命令，必须手动传 ctx（来自 search 输出）
  .option('--lid <lid>', 'BOSS list-context lid（来自 search 输出）')
  .option('--security-id <sid>', 'BOSS job securityId（来自 search 输出）')
  .action(async (jobId: string, options: {
    headless: boolean
    cdp?: boolean
    lid?: string
    securityId?: string
  }) => {
    const start = Date.now()
    let status: BaselineRecord['status'] = 'ok'
    const cdp = options.cdp ?? program.opts().cdp ?? false
    const config = loadConfig()
    const session = await createSession(cdp)
    const page = session.page

    try {
      console.log(chalk.cyan('📥 正在抓取岗位详情...'))
      // Sprint 2026-07-14 / task #34：传 lid/securityId 让 fetchJobDetail 走 wapi 路径
      const jd = await fetchJobDetail(page, jobId, {
        lid: options.lid,
        securityId: options.securityId,
      })

      const resumeSummary = buildResumeSummary({
        skills: ['TypeScript', 'React', 'Node.js'],
        yearsOfExperience: 3,
        education: '本科',
      })

      console.log(chalk.cyan('🤖 正在生成话术...'))
      const llm = createLLM(config)
      const greeting = await llm.generate(
        buildGreetingPrompt(jd, resumeSummary),
        buildGreetingSystemPrompt(),
      )

      console.log(chalk.green('\n📝 生成的话术:\n'))
      console.log(`  ${greeting}\n`)
      console.log(chalk.yellow('💡 使用 bapply send <jobId> -m "话术内容" 发送这段话术'))
    } catch (err: any) {
      status = 'fail'
      throw err
    } finally {
      await closeBrowserSession(session)
      await writeBaselineRecord({
        ts: new Date().toISOString(),
        command: 'greet',
        duration_ms: Date.now() - start,
        http_code: null,
        result_count: 0,
        status,
      })
    }
  })

// ============================================================
// send
// ============================================================

program
  .command('send')
  .description('发送打招呼消息并更新状态')
  .argument('<jobId>', '岗位 ID')
  // Sprint 2026-07-14 / ADR-0007 P3 协议：移除 -u/--hr-uid 和 -m/--message
  //   改用 -l/--lid + -s/--security-id（来自 search 输出）
  .requiredOption('-l, --lid <lid>', 'BOSS list-context lid（来自 search 输出）')
  .requiredOption('-s, --security-id <securityId>', 'BOSS 风控 token（来自 search 输出）')
  .option('--record-id <recordId>', '飞书记录 ID（如有，写回打招呼状态）')
  .option('--cdp', '通过 CDP 连接已有 Chrome')
  .action(async (jobId: string, options: { lid: string; securityId: string; recordId?: string; cdp?: boolean }) => {
    const start = Date.now()
    const cdp = options.cdp ?? program.opts().cdp ?? false

    console.log(chalk.cyan(`📤 正在向岗位 ${jobId} 发送打招呼...`))

    // Sprint 2A.2: 构造 writeGreetingStatus 依赖（用 config.feishu.appToken/tableId）
    //   - 缺配置时降级为 no-op（handler 会调它，result.reason 标注"飞书写入失败"）
    let writeGreetingStatus: ((recordId: string, status: string, greetedAt: number) => Promise<unknown>) | undefined
    try {
      const config = loadConfig()
      if (config.feishu.appToken && config.feishu.tableId) {
        const appToken = config.feishu.appToken
        const tableId = config.feishu.tableId
        writeGreetingStatus = async (recordId, status, greetedAt) => {
          return updateRecord(appToken, tableId, recordId, {
            打招呼状态: status,
            打招呼时间: greetedAt,
          })
        }
      }
    } catch {
      // loadConfig 失败不阻塞 send（writeGreetingStatus 保持 undefined → 跳过飞书写入）
    }

    // P0 fix: 调 runSendCommand 把 GuardError / 业务错误统一转 Result
    // CLI 层只负责 exit code 映射 + 友好输出，不再 unhandled rejection
    const result = await runSendCommand(
      { jobId, lid: options.lid, securityId: options.securityId, recordId: options.recordId, cdp },
      { writeGreetingStatus },
    )

    // 被动基线观测：在每个 case 的 process.exit 之前同步写入
    // （await writeBaselineRecord 在 process.exit 前会丢——async 不等 exit）
    switch (result.action) {
      case 'ok':
        console.log(chalk.green(`✅ ${result.reason}`))
        writeBaselineRecordSync({
          ts: new Date().toISOString(),
          command: 'send',
          duration_ms: Date.now() - start,
          http_code: null,
          result_count: 1,
          status: 'ok',
        })
        process.exit(SEND_EXIT_CODE.ok)
      case 'invalid_args':
        console.log(chalk.red(`❌ ${result.reason}`))
        writeBaselineRecordSync({
          ts: new Date().toISOString(),
          command: 'send',
          duration_ms: Date.now() - start,
          http_code: null,
          result_count: 0,
          status: 'fail',
        })
        process.exit(SEND_EXIT_CODE.invalid_args)
      case 'abort_today':
        // 风控关键 signal：红字 + 单独 exit code 3，便于 CI / 监控识别
        console.log(chalk.red(`\n🛑 风控今日上限：${result.reason}\n`))
        writeBaselineRecordSync({
          ts: new Date().toISOString(),
          command: 'send',
          duration_ms: Date.now() - start,
          http_code: null,
          result_count: 0,
          status: 'interrupted',
          interrupted_reason: 'rate_limit',
        })
        process.exit(SEND_EXIT_CODE.abort_today)
      case 'abort':
        console.log(chalk.red(`\n🛑 风控阻断：${result.reason}\n`))
        writeBaselineRecordSync({
          ts: new Date().toISOString(),
          command: 'send',
          duration_ms: Date.now() - start,
          http_code: null,
          result_count: 0,
          status: 'interrupted',
          interrupted_reason: 'guard_pause',
        })
        process.exit(SEND_EXIT_CODE.abort)
      case 'failed':
        console.log(chalk.red(`❌ ${result.reason}`))
        writeBaselineRecordSync({
          ts: new Date().toISOString(),
          command: 'send',
          duration_ms: Date.now() - start,
          http_code: null,
          result_count: 0,
          status: 'fail',
        })
        process.exit(SEND_EXIT_CODE.failed)
    }
  })

// ============================================================
// list
// ============================================================

program
  .command('list')
  .description('查看多维表格中的岗位和状态')
  .option('-n, --limit <limit>', '每页条数', '20')
  .action(async (options: { limit?: string }) => {
    const start = Date.now()
    const limit = options.limit ? Number(options.limit) : 20

    if (!Number.isFinite(limit) || limit <= 0) {
      console.log(chalk.red(`❌ --limit 必须是正整数: ${options.limit}`))
      writeBaselineRecordSync({
        ts: new Date().toISOString(),
        command: 'list',
        duration_ms: Date.now() - start,
        http_code: null,
        result_count: 0,
        status: 'fail',
      })
      process.exit(LIST_EXIT_CODE.fail)
    }

    const result = await runListCommand({ limit })

    switch (result.action) {
      case 'ok':
        console.log(chalk.cyan(result.formatted))
        await writeBaselineRecord({
          ts: new Date().toISOString(),
          command: 'list',
          duration_ms: Date.now() - start,
          http_code: 200,
          result_count: result.recordCount,
          status: 'ok',
        })
        process.exit(LIST_EXIT_CODE.ok)
      case 'missing_config':
        console.log(chalk.yellow(`\n⚠️  ${result.reason}\n`))
        console.log(chalk.cyan(result.hint))
        writeBaselineRecordSync({
          ts: new Date().toISOString(),
          command: 'list',
          duration_ms: Date.now() - start,
          http_code: null,
          result_count: 0,
          status: 'fail',
        })
        process.exit(LIST_EXIT_CODE.missing_config)
      case 'fail':
        console.log(chalk.red(`\n❌ ${result.reason}\n`))
        writeBaselineRecordSync({
          ts: new Date().toISOString(),
          command: 'list',
          duration_ms: Date.now() - start,
          http_code: null,
          result_count: 0,
          status: 'fail',
        })
        process.exit(LIST_EXIT_CODE.fail)
    }
  })

// ============================================================
// sync
// ============================================================

program
  .command('sync')
  .description('同步飞书多维表格中的投递状态（读 / 单条更新 / 批量打招呼）')
  .option('--status <status>', '只看指定状态的岗位')
  .option('--update <recordId:status>', '更新单条记录，格式 recordId:新状态（如 rec_001:已沟通）')
  .option('--auto-greet', '批量调 BOSS 打招呼（只处理『待投递』岗位）')
  .option('--limit <n>', 'auto-greet 模式处理上限（默认 5）')
  .option('--dry-run', 'auto-greet 演练模式：只生成招呼语 + 验证 LLM 输出，不真实发消息、不改飞书')
  .action(async (options: {
    status?: string
    update?: string
    autoGreet?: boolean
    limit?: string
    dryRun?: boolean
  }) => {
    const start = Date.now()

    // 解析 --update 参数（"rec_001:已沟通" → recordId + status）
    let updateRecordId: string | undefined
    let updateStatus: string | undefined
    if (options.update) {
      const idx = options.update.indexOf(':')
      if (idx === -1) {
        console.log(chalk.red(`❌ --update 格式错误，应为 recordId:status（如 rec_001:已沟通）`))
        writeBaselineRecordSync({
          ts: new Date().toISOString(),
          command: 'sync',
          duration_ms: Date.now() - start,
          http_code: null,
          result_count: 0,
          status: 'fail',
        })
        process.exit(SYNC_EXIT_CODE.invalid_args)
      }
      updateRecordId = options.update.slice(0, idx)
      updateStatus = options.update.slice(idx + 1)
    }

    // 解析 --limit
    let limitN: number | undefined
    if (options.limit !== undefined) {
      const n = Number(options.limit)
      if (!Number.isFinite(n) || n <= 0) {
        console.log(chalk.red(`❌ --limit 必须是正整数: ${options.limit}`))
        writeBaselineRecordSync({
          ts: new Date().toISOString(),
          command: 'sync',
          duration_ms: Date.now() - start,
          http_code: null,
          result_count: 0,
          status: 'fail',
        })
        process.exit(SYNC_EXIT_CODE.invalid_args)
      }
      limitN = n
    }

    // 决定模式：--update > --auto-greet > --status > 默认
    const mode: 'update' | 'auto-greet' | 'filter' | 'list' = options.update
      ? 'update'
      : options.autoGreet
        ? 'auto-greet'
        : options.status
          ? 'filter'
          : 'list'

    const result = await runSyncCommand({
      mode,
      status: options.status ?? updateStatus,
      recordId: updateRecordId,
      limit: limitN,
      dryRun: options.dryRun,
    })

    switch (result.action) {
      case 'list':
        console.log(chalk.cyan(result.formatted))
        await writeBaselineRecord({
          ts: new Date().toISOString(),
          command: 'sync',
          duration_ms: Date.now() - start,
          http_code: 200,
          result_count: result.totalCount,
          status: 'ok',
        })
        process.exit(SYNC_EXIT_CODE.list)
      case 'ok':
        console.log(chalk.green(`✅ 已更新 ${result.recordId} → ${result.status}`))
        await writeBaselineRecord({
          ts: new Date().toISOString(),
          command: 'sync',
          duration_ms: Date.now() - start,
          http_code: 200,
          result_count: 1,
          status: 'ok',
        })
        process.exit(SYNC_EXIT_CODE.ok)
      case 'auto-greet':
        console.log(chalk.cyan(result.formatted))
        // dry-run：永远是 'ok'（dry-run 本来就是验证流程，发现错误是预期行为，不算 fail）
        if (result.dryRun) {
          writeBaselineRecordSync({
            ts: new Date().toISOString(),
            command: 'sync',
            duration_ms: Date.now() - start,
            http_code: null,
            result_count: result.messages?.length ?? 0,
            status: 'ok',
          })
        } else {
          // 真实 auto-greet：succeeded+failed 都记录
          writeBaselineRecordSync({
            ts: new Date().toISOString(),
            command: 'sync',
            duration_ms: Date.now() - start,
            http_code: null,
            result_count: result.succeeded,
            status: result.failed === 0 ? 'ok' : 'interrupted',
            interrupted_reason: result.failed > 0 ? 'rate_limit' : undefined,
          })
        }
        process.exit(SYNC_EXIT_CODE['auto-greet'])
      case 'missing_config':
        console.log(chalk.yellow(`\n⚠️  ${result.reason}\n`))
        console.log(chalk.cyan(result.hint))
        writeBaselineRecordSync({
          ts: new Date().toISOString(),
          command: 'sync',
          duration_ms: Date.now() - start,
          http_code: null,
          result_count: 0,
          status: 'fail',
        })
        process.exit(SYNC_EXIT_CODE.missing_config)
      case 'invalid_args':
        console.log(chalk.red(`\n❌ ${result.reason}\n`))
        writeBaselineRecordSync({
          ts: new Date().toISOString(),
          command: 'sync',
          duration_ms: Date.now() - start,
          http_code: null,
          result_count: 0,
          status: 'fail',
        })
        process.exit(SYNC_EXIT_CODE.invalid_args)
      case 'fail':
        console.log(chalk.red(`\n❌ ${result.reason}\n`))
        writeBaselineRecordSync({
          ts: new Date().toISOString(),
          command: 'sync',
          duration_ms: Date.now() - start,
          http_code: null,
          result_count: 0,
          status: 'fail',
        })
        process.exit(SYNC_EXIT_CODE.fail)
    }
  })

// ============================================================
// stats
// ============================================================

program
  .command('stats')
  .description('投递统计概览（总数/状态分布/漏斗/Top 公司）')
  .option('--top <n>', 'Top N 公司', '5')
  .action(async (options: { top?: string }) => {
    const start = Date.now()
    const topN = options.top ? Number(options.top) : 5

    if (!Number.isFinite(topN) || topN <= 0) {
      console.log(chalk.red(`❌ --top 必须是正整数: ${options.top}`))
      writeBaselineRecordSync({
        ts: new Date().toISOString(),
        command: 'stats',
        duration_ms: Date.now() - start,
        http_code: null,
        result_count: 0,
        status: 'fail',
      })
      process.exit(STATS_EXIT_CODE.fail)
    }

    const result = await runStatsCommand({ topN })

    switch (result.action) {
      case 'ok':
        console.log(chalk.cyan(result.formatted))
        await writeBaselineRecord({
          ts: new Date().toISOString(),
          command: 'stats',
          duration_ms: Date.now() - start,
          http_code: 200,
          result_count: result.totalCount,
          status: 'ok',
        })
        process.exit(STATS_EXIT_CODE.ok)
      case 'missing_config':
        console.log(chalk.yellow(`\n⚠️  ${result.reason}\n`))
        console.log(chalk.cyan(result.hint))
        writeBaselineRecordSync({
          ts: new Date().toISOString(),
          command: 'stats',
          duration_ms: Date.now() - start,
          http_code: null,
          result_count: 0,
          status: 'fail',
        })
        process.exit(STATS_EXIT_CODE.missing_config)
      case 'fail':
        console.log(chalk.red(`\n❌ ${result.reason}\n`))
        writeBaselineRecordSync({
          ts: new Date().toISOString(),
          command: 'stats',
          duration_ms: Date.now() - start,
          http_code: null,
          result_count: 0,
          status: 'fail',
        })
        process.exit(STATS_EXIT_CODE.fail)
    }
  })

// ============================================================
// chrome（输出启动 Chrome 远程调试的命令）
// ============================================================

program
  .command('chrome')
  .description('打印启动本地 Chrome（远程调试模式）的命令 — 接管模式第一步')
  .option('-p, --port <port>', '自定义端口（覆盖 BOSS_CDP_PORT 与默认 9222）')
  .action((options: { port?: string }) => {
    const portNum = options.port ? Number(options.port) : undefined
    const out = handleChromeCommand({ port: portNum })
    console.log(chalk.cyan(out))
  })

program.parse()
