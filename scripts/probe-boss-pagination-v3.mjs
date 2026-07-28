#!/usr/bin/env node
// ============================================================
// probe-boss-pagination-v3.mjs
// ============================================================
// 修复 v2 bug：page.goto 在详情页 tab 上不跳转
// 解决：新开 tab + 真正进入 /web/geek/jobs + 等 SPA 加载 + 触发搜索 + 滚动
//
// 多假设（user 反馈 last_id 连续分页）：
//   H1: last_id 连续分页（user 假设）— body 含 lastId / last_id
//   H2: page=N 翻页
//   H3: cursor / scroll_id
//   H4: pageSize + scroll（无明确 cursor）
// ============================================================

import { chromium } from 'playwright-extra'

const CDP_URL = 'http://localhost:9222'
const USER_URL = 'https://www.zhipin.com/web/geek/jobs?city=101210100&position=100101&jobType=1901&salary=406&experience=106&degree=203&industry=100020,100206,100804'

async function main() {
  const browser = await chromium.connectOverCDP(CDP_URL)
  const context = browser.contexts()[0]
  if (!context) throw new Error('CDP context 不存在')

  // 修复：开一个全新 tab（不复用详情页 tab）
  console.log('🆕 开新 tab（不污染详情页）')
  const page = await context.newPage()
  console.log(`📍 新 tab 初始 url: ${page.url()}\n`)

  const captured = []
  page.on('request', (req) => {
    const url = req.url()
    if (url.includes('zhipin.com/wapi') || url.includes('zhipin.com/web/')) {
      captured.push({
        method: req.method(),
        url,
        postData: req.postData(),
        ts: Date.now(),
      })
    }
  })
  page.on('response', async (resp) => {
    const url = resp.url()
    if (url.includes('zhipin.com/wapi') || url.includes('zhipin.com/web/')) {
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

  console.log(`🌐 goto ${USER_URL}\n`)
  await page.goto(USER_URL, { waitUntil: 'domcontentloaded', timeout: 30000 })
  console.log(`📍 page.url() = ${page.url()}`)
  console.log(`📍 page.title() = ${await page.title().catch(() => 'N/A')}\n`)

  // 等 SPA 完全加载
  await new Promise(r => setTimeout(r, 5000))

  console.log(`📍 5s 后 page.url() = ${page.url()}\n`)

  // DOM 计数
  const cardCounts = await page.evaluate(() => ({
    jobCardBox: document.querySelectorAll('.job-card-box').length,
    jobCardWrapper: document.querySelectorAll('.job-card-wrapper').length,
    jobCardLeft: document.querySelectorAll('.job-card-left').length,
    kaSearchList: document.querySelectorAll('a[ka^="search_list_"]').length,
    bodyStart: document.body ? document.body.innerText.slice(0, 200) : '(no body)',
  })).catch((e) => ({ error: e.message }))
  console.log(`📊 DOM 计数: ${JSON.stringify(cardCounts, null, 2)}\n`)

  // 滚动 4 次触发懒加载
  console.log(`📜 滚动 4 次触发分页...\n`)
  for (let i = 0; i < 4; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    await new Promise(r => setTimeout(r, 2500))
    const cardCount = await page.evaluate(() => document.querySelectorAll('.job-card-box, .job-card-wrapper').length).catch(() => 'N/A')
    console.log(`  scroll ${i + 1}/4 done — DOM jobCard: ${cardCount}`)
  }

  await new Promise(r => setTimeout(r, 3000))

  console.log(`\n📦 共捕获到 ${captured.length} 个 BOSS API 调用\n`)

  // 找含 zpData.jobList 的调用（最可能是 search API）
  const jobListCalls = captured.filter((c) => c.response?.listLen > 0)
  console.log(`\n🎯 含 jobList 的 API 调用: ${jobListCalls.length}\n`)

  if (jobListCalls.length === 0) {
    console.log(`⚠️ BOSS web 没触发任何返 jobList 的 API`)
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

  await browser.close()
}

main().catch((err) => {
  console.error('❌ 抓包失败:', err.message)
  process.exit(1)
})