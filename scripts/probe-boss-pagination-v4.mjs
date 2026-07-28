#!/usr/bin/env node
// ============================================================
// probe-boss-pagination-v4.mjs
// ============================================================
// 目的：接管 user Chrome 已开的 BOSS 搜索页 Tab 2，监听 + 滚动 + 抓分页
// 修复：v1/v2/v3 全部因 newPage 被风控到 about:blank
// 解决：接管 user 已存在的 Tab（共享 context/fingerprint/cookie/storage）
//
// 多假设（user 反馈 last_id 连续分页）：
//   H1: last_id 连续分页（user 假设）— body 含 lastId / last_id
//   H2: page=N 翻页
//   H3: cursor / scroll_id
// ============================================================

import { chromium } from 'playwright-extra'

const CDP_URL = 'http://localhost:9222'
const TARGET_HOST = '/web/geek/jobs'

async function main() {
  const browser = await chromium.connectOverCDP(CDP_URL)
  const context = browser.contexts()[0]
  if (!context) throw new Error('CDP context 不存在')

  // 列所有 tab
  const pages = context.pages()
  console.log(`📋 Chrome 当前 tabs: ${pages.length}`)
  pages.forEach((p, i) => {
    console.log(`  [${i + 1}] ${p.url()?.slice(0, 120)}`)
  })

  // 找 BOSS 搜索页
  const searchPage = pages.find((p) => (p.url() || '').includes(TARGET_HOST))
  if (!searchPage) {
    console.log(`❌ 没找到 ${TARGET_HOST} tab`)
    await browser.close()
    return
  }
  console.log(`\n✅ 找到 BOSS 搜索页: ${searchPage.url()}\n`)

  const captured = []
  searchPage.on('request', (req) => {
    const url = req.url()
    if (url.includes('zhipin.com')) {
      captured.push({
        method: req.method(),
        url,
        postData: req.postData(),
        ts: Date.now(),
      })
    }
  })
  searchPage.on('response', async (resp) => {
    const url = resp.url()
    if (url.includes('zhipin.com')) {
      const last = [...captured].reverse().find((c) => c.url === url && !c.response)
      if (last) {
        try {
          const text = await resp.text()
          let json
          try { json = JSON.parse(text) } catch { json = { _raw: text.slice(0, 300) } }
          last.response = {
            status: resp.status(),
            listLen: json?.zpData?.jobList?.length,
            totalCount: json?.zpData?.totalCount,
            hasLastId: json?.zpData ? ('lastId' in json.zpData || 'last_id' in json.zpData || 'cursor' in json.zpData) : false,
            lastIdValue: json?.zpData?.lastId ?? json?.zpData?.last_id ?? json?.zpData?.cursor ?? null,
            zpDataKeys: json?.zpData ? Object.keys(json.zpData).slice(0, 20) : [],
            firstJob: json?.zpData?.jobList?.[0] ? `${json.zpData.jobList[0].jobName}@${json.zpData.jobList[0].brandName}` : '(empty)',
          }
        } catch (e) {
          last.responseError = e?.message?.slice(0, 100)
        }
      }
    }
  })

  console.log(`📍 接管后 page.url() = ${searchPage.url()}`)
  console.log(`📍 接管后 page.title() = ${await searchPage.title().catch(() => 'N/A')}\n`)

  const cardCount = await searchPage.evaluate(() => document.querySelectorAll('.job-card-box, .job-card-wrapper').length).catch((e) => `ERROR: ${e.message}`)
  console.log(`📊 DOM jobCard 数: ${cardCount}\n`)

  console.log(`📜 滚动 4 次触发分页...\n`)
  for (let i = 0; i < 4; i++) {
    await searchPage.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    await new Promise(r => setTimeout(r, 2500))
    const count = await searchPage.evaluate(() => document.querySelectorAll('.job-card-box, .job-card-wrapper').length).catch(() => 'N/A')
    console.log(`  scroll ${i + 1}/4 done — DOM jobCard: ${count} — page.url()=${searchPage.url()?.slice(0, 80)}`)
  }

  await new Promise(r => setTimeout(r, 3000))

  console.log(`\n📦 共捕获到 ${captured.length} 个 BOSS API 调用\n`)

  // 找含 jobList 的调用
  const jobListCalls = captured.filter((c) => c.response?.listLen > 0)
  console.log(`\n🎯 含 jobList 的 API 调用: ${jobListCalls.length}\n`)

  if (jobListCalls.length === 0) {
    console.log(`⚠️ 没抓到 search 类 API`)
    console.log(`\n全部调用分类（按 host+path）：`)
    const grouped = {}
    captured.forEach((c) => {
      try {
        const u = new URL(c.url)
        const key = `${u.hostname}${u.pathname}`
        grouped[key] = (grouped[key] || 0) + 1
      } catch {}
    })
    Object.entries(grouped)
      .sort((a, b) => b[1] - a[1])
      .forEach(([k, v]) => {
        console.log(`  ${String(v).padStart(3)}× ${k}`)
      })
  } else {
    jobListCalls.forEach((c, i) => {
      console.log(`[J${i + 1}] ${new Date(c.ts).toISOString().slice(11, 19)} ${c.method} ${c.url}`)
      if (c.postData) {
        try {
          const parsed = JSON.parse(c.postData)
          console.log(`  body:    ${JSON.stringify(parsed, null, 2)}`)
        } catch {
          console.log(`  body:    ${c.postData}`)
        }
      }
      console.log(`  resp:    status=${c.response.status} listLen=${c.response.listLen} totalCount=${c.response.totalCount}`)
      console.log(`  hasLastId: ${c.response.hasLastId}  lastId/cursor: ${c.response.lastIdValue}`)
      console.log(`  zpData keys: ${c.response.zpDataKeys.join(', ')}`)
      console.log(`  firstJob:   ${c.response.firstJob}\n`)
    })
  }

  console.log(`\n📍 结束后 page.url() = ${searchPage.url()}\n`)

  // 不关 browser（user 还在用）
}

main().catch((err) => {
  console.error('❌ 抓包失败:', err.message)
  process.exit(1)
})