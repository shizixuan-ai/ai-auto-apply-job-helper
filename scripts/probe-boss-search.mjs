#!/usr/bin/env node
// ============================================================
// scripts/probe-boss-search.mjs — Sprint E-3.4b (§3.12 probe 前置)
//
// 目的: 真浏览器 + 真 LLM + 真飞书 — 只跑 search+score+写飞书 (不跑 sendGreeting)
//   验证:
//     1) searchJobs 不报错 (与 cookies 49h 有效期一致)
//     2) fetchJobDetail 走 wapi 路径
//     3) LLM scoreJob 真实扣费 + 返回 6 维评分
//     4) createRecord 真写飞书 (返 record_id)
//     5) passingJobs[] 透传给 auto-handler.bossSearch 链
//
// 注: 故意不跑 sendGreeting (避免单账号撞墙 — per memory feedback_boss_anti_bot_status.md)
//
// 用法: npx tsx scripts/probe-boss-search.mjs [keyword] [city] [limit]
//       默认: "Java 后端" "北京" 1
//
// 输出: /tmp/boss-search-probe.json (passingJobs + 摘要)
// ============================================================

// Sprint 2026-07-18 bug fix: dotenv 早于所有 import 求值
import 'dotenv/config'

import * as fs from 'node:fs/promises'
import * as path from 'node:path'

const KEYWORD = process.argv[2] ?? 'Java 后端'
const CITY = process.argv[3] ?? '北京'
const LIMIT = Number(process.argv[4] ?? 1)

console.log('━'.repeat(60))
console.log(`🔍 probe-boss-search (Sprint E-3.4b §3.12)`)
console.log(`   keyword:   ${KEYWORD}`)
console.log(`   city:      ${CITY}`)
console.log(`   limit:     ${LIMIT}`)
console.log(`   threshold: ${process.env.SCORE_THRESHOLD ?? '0.85 (default)'}`)
console.log(`   ts:        ${new Date().toISOString()}`)
console.log('━'.repeat(60))

// 动态 import (tsx 解析 TS)
const { createBrowserSession, closeBrowserSession, createCDPSession, searchJobs, fetchJobDetail } = await import('../src/browser/index.js')
const USE_CDP = process.argv.includes('--cdp')
const { createRecord } = await import('../src/feishu/index.js')
const { createLLM } = await import('../src/llm/index.js')
const { loadConfig } = await import('../src/config/index.js')
const { resolveResume } = await import('../src/resume/resolver.js')
const { scoreJob } = await import('../src/scoring/index.js')
const { runSearchAndWrite } = await import('../src/cli/handlers/search-and-write.js')

// 1. 配置检查
const config = loadConfig()
console.log(`\n[1] config 加载 OK`)
console.log(`   feishu.appToken: ${config.feishu.appToken?.slice(0, 8)}...`)
console.log(`   feishu.tableId:  ${config.feishu.tableId?.slice(0, 8)}...`)
console.log(`   llm.provider:    ${config.llm.provider}`)
console.log(`   scoreThreshold:  ${config.scoreThreshold}`)

// 2. 简历解析
console.log(`\n[2] 解析简历...`)
const resume = await resolveResume()
console.log(`   skills:    ${resume.summary.skills.join(', ')}`)
console.log(`   warnings:  ${resume.warnings.length} 个`)

// 3. 创建浏览器 (CDP 优先; 默认 stealth launch)
console.log(`\n[3] 打开浏览器 (mode=${USE_CDP ? 'CDP 接管' : 'stealth headless'})...`)
if (USE_CDP) {
  console.log('    [!] 需 user 先跑 `bapply chrome` 启动 Chrome remote-debug')
}
const session = USE_CDP ? await createCDPSession() : await createBrowserSession(true)
try {
  const page = session.page

  // 4. LLM 实例
  console.log(`\n[4] 初始化 LLM (${config.llm.provider})...`)
  const llm = createLLM(config)
  console.log(`   ✅ llm ready`)

  // 5. 调 runSearchAndWrite (复用 CLI 层 deps 链)
  console.log(`\n[5] 跑 search+score+写飞书 (limit=${LIMIT})...`)
  const startTs = Date.now()
  const result = await runSearchAndWrite(
    {
      keyword: KEYWORD,
      city: CITY,
      write: true,            // ★ probe 模式: 真写 (验证飞书写入链路)
      dryRun: false,
      noThreshold: false,
      limit: LIMIT,
    },
    {
      searchJobs: async (_k, _c) => {
        return await searchJobs(page, KEYWORD, CITY, undefined, { maxResults: LIMIT })
      },
      fetchJobDetail: (jobId, ctx) =>
        fetchJobDetail(page, jobId, { lid: ctx?.lid, securityId: ctx?.securityId }),
      scoreJob: (jd, summary, _llm) => scoreJob(jd, summary, llm),
      createRecord: async (fields) => createRecord(
        config.feishu.appToken ?? '',
        config.feishu.tableId ?? '',
        fields,
      ),
      resolveResume: async () => resume,
      llm,
      threshold: config.scoreThreshold,
    },
  )
  const elapsed = Date.now() - startTs

  console.log(`\n[6] ✨ runSearchAndWrite 跑完 (${elapsed}ms)`)
  if (result.action === 'error') {
    console.error(`   ❌ error: ${result.error}`)
    process.exit(1)
  }
  console.log(`   action:        ${result.action}`)
  console.log(`   total:         ${result.total}`)
  console.log(`   scored:        ${result.scored}`)
  console.log(`   passed (≥${config.scoreThreshold}): ${result.passed}`)
  console.log(`   written:       ${result.written}`)
  console.log(`   failed:        ${result.failed}`)
  console.log(`   passingJobs:   ${result.passingJobs.length}`)

  // 7. 写 /tmp/boss-search-probe.json (供 review)
  const probeData = {
    ts: new Date().toISOString(),
    keyword: KEYWORD,
    city: CITY,
    limit: LIMIT,
    threshold: config.scoreThreshold,
    elapsed_ms: elapsed,
    summary: {
      total: result.total,
      scored: result.scored,
      passed: result.passed,
      written: result.written,
      failed: result.failed,
      passingJobsCount: result.passingJobs.length,
    },
    passingJobs: result.passingJobs,
    feishuWritten: result.written > 0,
  }
  await fs.writeFile(
    '/tmp/boss-search-probe.json',
    JSON.stringify(probeData, null, 2),
    'utf8',
  )
  console.log(`\n[7] 摘要 → /tmp/boss-search-probe.json`)

  if (result.passingJobs.length > 0) {
    console.log(`\n[8] passingJobs[] (前 ${Math.min(3, result.passingJobs.length)}):`)
    result.passingJobs.slice(0, 3).forEach((pj, i) => {
      console.log(`   ${i + 1}. ${pj.title} (${pj.jobId.slice(0, 12)}...)`)
      console.log(`      score:      ${pj.score.toFixed(2)}`)
      console.log(`      record_id:  ${pj.recordId}`)
      console.log(`      lid:        ${pj.lid?.slice(0, 16) ?? '(empty)'}`)
      console.log(`      securityId: ${pj.securityId?.slice(0, 16) ?? '(empty)'}...`)
    })
  }

  console.log(`\n✅ probe-boss-search 完成`)
  console.log(`   下一步: review /tmp/boss-search-probe.json + 飞书表新记录`)
  console.log(`           再决定: 是否进 E-3.4 (dryRun=false 真发)`)
} finally {
  try {
    await closeBrowserSession(session)
    console.log(`\n[cleanup] session closed`)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.warn(`[cleanup] closeSession 失败: ${msg}`)
  }
}
