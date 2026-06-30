#!/usr/bin/env node

// ============================================================
// CLI 入口 — commander
// ============================================================
// 命令: init | login | search | greet | send
// ============================================================

import { Command } from 'commander'
import chalk from 'chalk'
import { loadConfig } from '../config/index.js'
import { createBrowserSession, createCDPSession, closeBrowserSession, loginByQR, searchJobs, fetchJobDetail, sendGreeting } from '../browser/index.js'
import { createLLM } from '../llm/index.js'
import { buildGreetingSystemPrompt, buildGreetingPrompt, buildResumeSummary } from '../template/index.js'
import { listRecords, createRecord, updateRecord } from '../feishu/index.js'
import { handleChromeCommand } from './handlers/chrome-handler.js'

const program = new Command()

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
      console.log(chalk.red(`❌ ${err.message}`))
      process.exit(1)
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
    const cdp = options.cdp ?? program.opts().cdp ?? false
    const session = await createSession(cdp)
    const page = session.page

    try {
      await loginByQR(page)
    } finally {
      await closeBrowserSession(session)
    }
  })

// ============================================================
// search
// ============================================================

program
  .command('search')
  .description('搜索岗位并展示列表')
  .argument('<keyword>', '搜索关键词，如 "前端开发"')
  .option('-c, --city <city>', '城市，如 "北京"')
  .option('--headless', '无头模式运行', false)
  .option('--cdp', '通过 CDP 连接已有 Chrome')
  .action(async (keyword: string, options: { city?: string; headless: boolean; cdp?: boolean }) => {
    const cdp = options.cdp ?? program.opts().cdp ?? false
    const session = cdp
      ? await createCDPSession()
      : await createBrowserSession(!options.headless)
    const page = session.page

    try {
      const jobs = await searchJobs(page, keyword, options.city)

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
    } finally {
      await closeBrowserSession(session)
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
  .action(async (jobId: string, options: { headless: boolean; cdp?: boolean }) => {
    const cdp = options.cdp ?? program.opts().cdp ?? false
    const config = loadConfig()
    const session = await createSession(cdp)
    const page = session.page

    try {
      console.log(chalk.cyan('📥 正在抓取岗位详情...'))
      const jd = await fetchJobDetail(page, jobId)

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
    } finally {
      await closeBrowserSession(session)
    }
  })

// ============================================================
// send
// ============================================================

program
  .command('send')
  .description('发送打招呼消息并更新状态')
  .argument('<jobId>', '岗位 ID')
  .option('-m, --message <message>', '话术内容')
  .option('--cdp', '通过 CDP 连接已有 Chrome')
  .action(async (jobId: string, options: { message?: string; cdp?: boolean }) => {
    const cdp = options.cdp ?? program.opts().cdp ?? false
    const session = await createSession(cdp)
    const page = session.page

    try {
      const message = options.message
      if (!message) {
        console.log(chalk.red('❌ 请通过 -m 指定话术内容'))
        process.exit(1)
      }

      console.log(chalk.cyan(`📤 正在向岗位 ${jobId} 发送打招呼...`))
      const success = await sendGreeting(page, jobId, message)

      if (success) {
        console.log(chalk.green('✅ 发送成功'))
      }
    } finally {
      await closeBrowserSession(session)
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
