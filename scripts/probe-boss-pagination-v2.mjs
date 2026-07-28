#!/usr/bin/env node
// ============================================================
// probe-boss-pagination-v2.mjs
// ============================================================
// 修复 v1 bug + 打印全部 93 个调用 + 看 page.url() 是否重定向
// ============================================================

import { chromium } from 'playwright-extra'

const CDP_URL = 'http://localhost:9222'
const USER_URL = 'https://www.zhipin.com/web/geek/jobs?city=101210100&position=100101&jobType=1901&salary=406&experience=106&degree=203&industry=100020,100206,100804'

async function main() {
  const browser = await chromium.connectOverCDP(CDP_URL)
  const context = browser.contexts()[0]
  if (!context) throw new Error('CDP context 不存在')

  let page = context.pages().find((p) => (p.url() || '').includes('zhipin.com'))
  if (!page) {
    console.log('⚠️ 无 zhipin tab，newPage')
    page = await context.newPage()
  }

  const captured = []
  page.on('request', (req) => {
    const url = req.url()
    if (url.includes('zhipin.com')) {
      captured.push({
        method: req.method(),
        url,
        postData: req.postData(),
        ts: Date.now(),
        response: null,
      })
    }
  })
  page.on('response', async (resp) => {
    const url = resp.url()
    if (url.includes('zhipin.com')) {
      // 找最后一个匹配 url 且无 response 的
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
            hasLastId: json?.zpData ? ('lastId' in json.zpData || 'last_id' in json.zpData) : false,
            lastIdValue: json?.zpData?.lastId ?? json?.zpData?.last_id ?? null,
            zpDataKeys: json?.zpData ? Object.keys(json.zpData).slice(0, 20) : [],
          }
        } catch (e) {
          last.responseError = e?.message?.slice(0, 100)
        }
      }
    }
  })

  console.log(`🌐 打开 BOSS web search: ${USER_URL}\n`)
  await page.goto(USER_URL, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await new Promise(r => setTimeout(r, 3000))

  // 打印 page.url() 看是否被重定向
  const pageUrl = page.url()
  console.log(`📍 page.url() = ${pageUrl}`)
  console.log(`📍 page.title() = ${await page.title().catch(() => 'N/A')}\n`)

  // 多种 jobCard selector
  const cardCounts = await page.evaluate(() => ({
    jobCardBox: document.querySelectorAll('.job-card-box').length,
    jobCardWrapper: document.querySelectorAll('.job-card-wrapper').length,
    jobCardLeft: document.querySelectorAll('.job-card-left').length,
    jobPrimary: document.querySelectorAll('[class*="job-primary"]').length,
    kaSearchList: document.querySelectorAll('a[ka^="search_list_"]').length,
    kaJobCard: document.querySelectorAll('[ka^="list_jd_"]').length,
    jobList: document.querySelectorAll('.job-list').length,
    body: document.body ? document.body.innerText.slice(0, 500) : '(no body)',
  })).catch((e) => ({ error: e.message }))
  console.log(`📊 DOM 计数: ${JSON.stringify(cardCounts, null, 2)}\n`)

  console.log(`📜 滚动到底部触发懒加载（连续 3 次）...\n`)
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    await new Promise(r => setTimeout(r, 2500))
  }

  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
  await new Promise(r => setTimeout(r, 3000))

  console.log(`\n📦 共捕获到 ${captured.length} 个 BOSS API 调用\n`)

  // 分类打印
  const searchCalls = captured.filter((c) => c.url.includes('search') || c.url.includes('joblist'))
  const otherCalls = captured.filter((c) => !c.url.includes('search') && !c.url.includes('joblist'))

  console.log(`\n🔍 含 search/joblist 的调用: ${searchCalls.length}\n`)
  if (searchCalls.length === 0) {
    console.log('  ⚠️ BOSS web 没调 search API！')
  }
  searchCalls.forEach((c, i) => {
    console.log(`  [S${i + 1}] ${c.method} ${c.url.slice(0, 150)}`)
    if (c.postData) console.log(`      postData: ${c.postData}`)
    if (c.response) {
      console.log(`      resp: status=${c.response.status} listLen=${c.response.listLen} hasLastId=${c.response.hasLastId} lastId=${c.response.lastIdValue}`)
      console.log(`      zpData keys: ${c.response.zpDataKeys.join(', ')}`)
    }
  })

  console.log(`\n📋 其他 BOSS 调用 (${otherCalls.length} 个，只列 URL):\n`)
  // 去重按 host+path 分类
  const grouped = {}
  otherCalls.forEach((c) => {
    const u = new URL(c.url)
    const key = `${u.hostname}${u.pathname}`
    grouped[key] = (grouped[key] || 0) + 1
  })
  Object.entries(grouped)
    .sort((a, b) => b[1] - a[1])
    .forEach(([k, v]) => {
      console.log(`  ${String(v).padStart(3)}× ${k}`)
    })

  // 打印 search 类的最后几个请求 URL（含 lastId 候选）
  console.log(`\n🔎 search 类调用 URL 完整列表:\n`)
  searchCalls.forEach((c, i) => {
    console.log(`  [${i + 1}] ${c.url}`)
  })

  await browser.close()
}

main().catch((err) => {
  console.error('❌ 抓包失败:', err.message)
  process.exit(1)
})