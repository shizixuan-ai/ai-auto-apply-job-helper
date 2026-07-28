#!/usr/bin/env node
// ============================================================
// probe-boss-pagination.mjs
// ============================================================
// 目的：抓 BOSS web 滚动时的真实分页 API 调用
// 多假设（user 反馈 last_id 连续分页）：
//   H1: last_id 连续分页（user 假设）— body 含 lastId / last_id
//   H2: page=N 翻页（CLI 当前用法）— body.page=2,3
//   H3: cursor / scroll_id
//   H4: pageSize + scroll（无明确 cursor）
//   H5: graphql cursor
//
// 方法：page.goto + 滚动到底部（连续 3 次）+ 捕获所有 /wapi/* 调用
// 对比 v3 probe 的 page=2/3 响应，看 BOSS web 真实用的是什么
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
    if (url.includes('zhipin.com/wapi') || url.includes('zhipin.com/joblist')) {
      captured.push({
        kind: 'request',
        method: req.method(),
        url,
        postData: req.postData(),
        headers: {
          'content-type': req.headers()['content-type'],
          'zp_token': req.headers()['zp_token']?.slice(0, 30) + '...',
          'x-requested-with': req.headers()['x-requested-with'],
        },
        ts: Date.now(),
      })
    }
  })
  page.on('response', async (resp) => {
    const url = resp.url()
    if (url.includes('zhipin.com/wapi') || url.includes('zhipin.com/joblist')) {
      const last = captured[captured.length - 1]
      if (last && last.url === url && !last.response) {
        try {
          const text = await resp.text()
          let json
          try { json = JSON.parse(text) } catch { json = { _raw: text.slice(0, 500) } }
          last.response = {
            status: resp.status(),
            totalCount: json?.zpData?.totalCount,
            jobListLength: json?.zpData?.jobList?.length,
            // H1: 检查 lastId / last_id
            hasLastId: json?.zpData ? ('lastId' in json.zpData || 'last_id' in json.zpData) : false,
            lastIdValue: json?.zpData?.lastId ?? json?.zpData?.last_id ?? null,
            zpDataKeys: json?.zpData ? Object.keys(json.zpData) : [],
            firstJob: json?.zpData?.jobList?.[0] ? `${json.zpData.jobList[0].jobName}@${json.zpData.jobList[0].brandName}` : '(empty)',
            lastJob: json?.zpData?.jobList?.[json.zpData.jobList.length - 1] ? `${json.zpData.jobList[json.zpData.jobList.length - 1].jobName}@${json.zpData.jobList[json.zpData.jobList.length - 1].brandName}` : '(empty)',
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

  // 看下页面初始 jobCard 数量（看 DOM 拿到几个 jobCard）
  const initialCardCount = await page.evaluate(() => {
    return document.querySelectorAll('.job-card-box, .job-card-wrapper').length
  }).catch(() => 'N/A')
  console.log(`📊 初始 DOM jobCard 数: ${initialCardCount}\n`)

  console.log(`📜 滚动到底部触发懒加载（连续 3 次）...\n`)
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    await new Promise(r => setTimeout(r, 2500))
    const cardCount = await page.evaluate(() => document.querySelectorAll('.job-card-box, .job-card-wrapper').length).catch(() => 'N/A')
    console.log(`  scroll ${i + 1}/3 done — DOM jobCard: ${cardCount}`)
  }

  // 最后再滚一次
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
  await new Promise(r => setTimeout(r, 3000))

  console.log(`\n📦 捕获到 ${captured.length} 个 BOSS API 调用:\n`)
  if (captured.length === 0) {
    console.log('⚠️ 未捕获到任何 BOSS API 调用')
  }

  captured.forEach((c, i) => {
    console.log(`[${i + 1}] ${new Date(c.ts).toISOString().slice(11, 19)}`)
    console.log(`  method:   ${c.method}`)
    console.log(`  url:      ${c.url}`)
    if (c.postData) {
      try {
        const parsed = JSON.parse(c.postData)
        console.log(`  postData: ${JSON.stringify(parsed, null, 2)}`)
      } catch {
        console.log(`  postData: ${c.postData}`)
      }
    }
    if (c.response) {
      console.log(`  resp:     status=${c.response.status} listLen=${c.response.jobListLength} totalCount=${c.response.totalCount}`)
      console.log(`  hasLastId: ${c.response.hasLastId}  lastId: ${c.response.lastIdValue}`)
      console.log(`  zpData keys: ${c.response.zpDataKeys.join(', ')}`)
      console.log(`  firstJob:   ${c.response.firstJob}`)
      console.log(`  lastJob:    ${c.response.lastJob}`)
    } else if (c.responseError) {
      console.log(`  resp:     ERROR ${c.response.responseError}`)
    }
    console.log()
  })

  // 找 listLen > 0 的调用（最可能是真实分页）
  const paginated = captured.filter((c) => c.response?.jobListLength > 0)
  console.log(`\n📊 含 jobList 的调用数: ${paginated.length}`)
  paginated.forEach((c, i) => {
    console.log(`  [${i + 1}] ${c.method} ${c.url.slice(0, 120)}`)
    console.log(`      postData=${c.postData}`)
    console.log(`      listLen=${c.response.jobListLength}  hasLastId=${c.response.hasLastId}  lastId=${c.response.lastIdValue}`)
  })

  await browser.close()
}

main().catch((err) => {
  console.error('❌ 抓包失败:', err.message)
  process.exit(1)
})