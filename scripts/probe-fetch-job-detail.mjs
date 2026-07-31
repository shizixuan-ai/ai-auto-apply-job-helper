#!/usr/bin/env node
// probe-fetch-job-detail.mjs — L2: 拿 L1 那个 job 的 JD, 验证 fetchJobDetail wapi 路径
// 用法: npx tsx scripts/probe-fetch-job-detail.mjs
//   依赖: /tmp/probe-search-result.json 必须存在 (L1 产生)

import 'dotenv/config'

import * as fs from 'node:fs/promises'
import { createBrowserSession, closeBrowserSession, createCDPSession, fetchJobDetail } from '../src/browser/index.js'

const USE_CDP = process.argv.includes('--cdp')
const jobJson = JSON.parse(await fs.readFile('/tmp/probe-search-result.json', 'utf8'))
console.log('━'.repeat(60))
console.log('🔍 probe-fetch-job-detail (L2 — 验 fetchJobDetail 拿 JD)')
console.log(`   jobId:      ${jobJson.id}`)
console.log(`   title:      ${jobJson.title}`)
console.log(`   lid:        ${jobJson.lid?.slice(0, 30) ?? '(空)'}`)
console.log(`   securityId: ${jobJson.securityId?.slice(0, 30) ?? '(空)'}...`)
console.log(`   mode:       ${USE_CDP ? 'CDP 接管' : 'stealth launch'}`)
console.log('━'.repeat(60))

const session = USE_CDP ? await createCDPSession() : await createBrowserSession(true)
try {
  console.log('[1] fetchJobDetail 调用中...')
  const t0 = Date.now()

  // 用 wapi 路径参数
  const jd = await fetchJobDetail(session.page, jobJson.id, {
    lid: jobJson.lid,
    securityId: jobJson.securityId,
  })
  const elapsed = Date.now() - t0

  console.log(`[2] fetchJobDetail 完成 (${elapsed}ms)`)
  console.log(`   jd length: ${jd.length}`)

  if (jd.length < 100) {
    console.log(`   ❌ JD 太短 (${jd.length} < 100 字符), 不是真 JD`)
    console.log(`   内容: ${jd.slice(0, 200)}`)
    process.exit(1)
  }

  console.log('[3] JD 前 300 字符:')
  console.log('   ┌' + '─'.repeat(58))
  console.log('   │ ' + jd.slice(0, 300).split('\n').join('\n   │ '))
  console.log('   └' + '─'.repeat(58))

  console.log('')
  console.log(`✅ L2 OK — JD 长度 ${jd.length} 字符, 正常`)
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e)
  console.error(`❌ L2 FAIL: ${msg.slice(0, 300)}`)
  console.error('')
  console.error('可能原因:')
  console.error('  1. cookies 已过期 → bapply login 重新扫码')
  console.error('  2. BOSS wapi 路径失败 → 降级到 page.goto 慢路径')
  console.error('  3. BOSS 改了 HTML selector')
  process.exit(1)
} finally {
  try { await closeBrowserSession(session) } catch {}
  console.log('[cleanup] closed')
}
