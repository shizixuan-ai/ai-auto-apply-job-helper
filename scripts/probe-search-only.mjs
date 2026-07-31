#!/usr/bin/env node
// probe-search-only.mjs — Sprint E-3.4: 单层纯 search 探针
// 不跑 fetchJobDetail / 写飞书, 只验 searchJobs 是否能返 ≥1 个有效 job
// 用法: npx tsx scripts/probe-search-only.mjs

import 'dotenv/config'

import { createBrowserSession, closeBrowserSession, createCDPSession, searchJobs } from '../src/browser/index.js'

const KEYWORD = process.argv[2] ?? 'Java 后端'
const CITY = process.argv[3] ?? undefined  // 故意不传 city 避开 geo-lock
const USE_CDP = process.argv.includes('--cdp')

console.log('━'.repeat(60))
console.log('🔍 probe-search-only (L1 — 最安全, 不 fetch/不写飞书)')
console.log(`   keyword: ${KEYWORD}`)
console.log(`   city:    ${CITY ?? '(空, 跟 BOSS 默认)'}`)
console.log(`   mode:    ${USE_CDP ? 'CDP 接管 (user 真 Chrome, 反爬最强)' : 'stealth launch (修补的 chromium)'}`)
console.log('━'.repeat(60))

if (USE_CDP) {
  console.log('[!] CDP 模式要求: 先在另一 Terminal 跑 `bapply chrome` 启动 Chrome remote-debug')
  console.log('    并在 Chrome 里手动访问一次 zhipin.com + 顶部切到目标城市')
}

const session = USE_CDP ? await createCDPSession() : await createBrowserSession(true)
try {
  console.log('[1] 浏览器已开 (headless)')

  console.log('[2] searchJobs 调用中...')
  const t0 = Date.now()
  const jobs = await searchJobs(session.page, KEYWORD, CITY, undefined, { maxResults: 5 })
  const elapsed = Date.now() - t0

  console.log(`[3] searchJobs 完成 (${elapsed}ms)`)
  console.log(`   total: ${jobs.length}`)

  if (jobs.length === 0) {
    console.log('   ⚠️  0 个 job — BOSS 没返, 检查 cookies / network / city')
    process.exit(1)
  }

  console.log('[4] 前 3 个 job:')
  jobs.slice(0, 3).forEach((j, i) => {
    console.log(`   ${i + 1}. ${j.title}`)
    console.log(`      ${j.company} | ${j.salary} | ${j.city}`)
    console.log(`      jobId:    ${j.id}`)
    console.log(`      lid:      ${j.lid?.slice(0, 20) ?? '(空)'}`)
    console.log(`      securityId (前 30 字符): ${j.securityId?.slice(0, 30) ?? '(空)'}...`)
  })

  // 把第 1 个 job 的关键字段存 /tmp 给下一层用
  const fs = await import('node:fs/promises')
  await fs.writeFile('/tmp/probe-search-result.json', JSON.stringify(jobs[0], null, 2), 'utf8')
  console.log('[5] 第 1 个 job → /tmp/probe-search-result.json (供 L2 fetchJobDetail 用)')
  console.log('')
  console.log('✅ L1 OK — searchJobs 返 ≥1 个有效 job (含 lid/securityId)')
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e)
  console.error(`❌ L1 FAIL: ${msg}`)
  process.exit(1)
} finally {
  try { await closeBrowserSession(session) } catch {}
  console.log('[cleanup] closed')
}
