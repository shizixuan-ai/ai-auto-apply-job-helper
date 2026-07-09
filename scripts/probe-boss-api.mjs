#!/usr/bin/env node
// ============================================================
// BOSS API 探针（Sprint 2B Step A — 补充 6）
// ============================================================
// 目的：真跑一次 searchJobs，从 BOSS 真实响应 dump 出第一条 job 的 schema
//       写入 tests/fixtures/boss-schema.json，作为契约测试的"黄金基准"
//
// 用法：
//   1. 先确保 Chrome 已启动 CDP 端口（参考 docs/agents/cdp-setup.md）
//   2. BOSS_SEARCH_PROBE=1 npm run probe:boss 前端架构师 杭州
//   3. cat tests/fixtures/boss-schema.json 看 userRelatedFields
//   4. 确认 HR 加密 uid 字段名（推断为 encryptUserId）
//   5. 若字段名不同，调整 src/browser/index.ts extractHrUid() 的 fallback chain
//   6. git add tests/fixtures/boss-schema.json 提交
//
// 为什么用 probe 而不是硬编码：
//   - 契约测试直接读 schema.json，不写死字段名
//   - BOSS 改版时只需重跑 probe，schema 自动更新，测试会立即变红
//   - 避免"测试绿但真跑挂"的根本问题（补充 6 设计的核心理由）
// ============================================================

import 'dotenv/config'
import { createCDPSession, closeBrowserSession, searchJobs } from '../src/browser/index.js'

const keyword = process.argv[2] || '前端'
const city = process.argv[3] || undefined

console.log(`[probe] 启动 CDP 会话 + searchJobs("${keyword}", ${city ? `"${city}"` : 'undefined'})`)
console.log(`[probe] BOSS_SEARCH_PROBE=1 已设置 → 写 tests/fixtures/boss-schema.json`)

try {
  // createCDPSession 返回 { browser, context, page, cdpMode }
  // searchJobs 是顶层函数，接受 page 作为第一参数
  const session = await createCDPSession() // CDP 模式：复用用户真 Chrome
  try {
    const jobs = await searchJobs(session.page, keyword, city)
    console.log(`[probe] searchJobs 返回 ${jobs.length} 个 job`)
    if (jobs.length > 0) {
      console.log(`[probe] sample job:`)
      console.log(`  id: ${jobs[0].id}`)
      console.log(`  title: ${jobs[0].title}`)
      console.log(`  company: ${jobs[0].company}`)
      console.log(`  hrUid: ${jobs[0].hrUid ?? '(undefined - 需检查 extractHrUid 字段名)'}`)
      if (!jobs[0].hrUid) {
        console.warn(`\n⚠️  [probe] hrUid 为空。可能原因:`)
        console.warn(`   1. BOSS API 字段名不是 encryptUserId / encryptedUserId / hrEncryptId`)
        console.warn(`   2. 字段名猜对但值为空（API 异常）`)
        console.warn(`   3. 请查看 tests/fixtures/boss-schema.json 的 userRelatedFields 找真实字段名`)
        console.warn(`   4. 然后调整 src/browser/index.ts extractHrUid() 的 fallback chain`)
      }
    }
  } finally {
    await closeBrowserSession(session)
  }
} catch (err) {
  console.error(`[probe] ❌ 失败: ${err.message}`)
  console.error(`\n排查步骤:`)
  console.error(`  1. Chrome 是否已用 --remote-debugging-port=9222 启动？`)
  console.error(`  2. BOSS 登录态是否有效（需要先 bapply login）？`)
  console.error(`  3. 端口 9222 是否被占用？lsof -i :9222`)
  process.exit(1)
}

console.log(`\n[probe] ✅ 完成。检查 tests/fixtures/boss-schema.json 的 userRelatedFields。`)