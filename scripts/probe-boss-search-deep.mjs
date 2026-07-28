#!/usr/bin/env node
// ============================================================
// probe-boss-search-deep.mjs
// ============================================================
// 目的：用 Playwright 抓 BOSS web search URL 时的真实 API 调用
//       对比 CLI probe-boss-search-api-v3.mjs 用的 body
//       找出"为什么累积 6 参数在 CLI 是反效果"
//
// 方法：page.on('request'/'response') 捕获所有 /wapi/zpgeek/search/* 调用
//       提取 postData + response，对比 CLI 的 body
// ============================================================

import { chromium } from 'playwright-extra'

const CDP_URL = 'http://localhost:9222'
const USER_URL = 'https://www.zhipin.com/web/geek/jobs?city=101210100&position=100101&jobType=1901&salary=406&experience=106&degree=203&industry=100020,100206,100804'

async function main() {
  const browser = await chromium.connectOverCDP(CDP_URL)
  const context = browser.contexts()[0]
  if (!context) throw new Error('CDP context 不存在')

  // 复用已有 zhipin tab，没有再 newPage
  let page = context.pages().find((p) => (p.url() || '').includes('zhipin.com'))
  if (!page) {
    console.log('⚠️ 无 zhipin tab，newPage')
    page = await context.newPage()
  }

  // 抓所有 search 相关 API 调用
  const captured = []
  page.on('request', (req) => {
    const url = req.url()
    if (url.includes('zhipin.com/wapi') && (url.includes('search') || url.includes('joblist') || url.includes('recommend'))) {
      captured.push({
        kind: 'request',
        method: req.method(),
        url,
        postData: req.postData(),
        headers: {
          'content-type': req.headers()['content-type'],
          'zp_token': req.headers()['zp_token'],
          'x-requested-with': req.headers()['x-requested-with'],
        },
      })
    }
  })
  page.on('response', async (resp) => {
    const url = resp.url()
    if (url.includes('zhipin.com/wapi') && (url.includes('search') || url.includes('joblist') || url.includes('recommend'))) {
      const last = captured[captured.length - 1]
      if (last && last.url === url && !last.response) {
        try {
          const json = await resp.json()
          // Sprint 2026-07-18：dump zpData 顶层 keys + scalar 值
          //   目的：找分页停止信号字段名（totalCount 是 undefined，真名未知）
          //   排除 jobList 数组本身（太长），只留 key 名 + 非数组/非对象的标量值
          const zp = json?.zpData ?? {}
          const zpKeys = Object.keys(zp)
          const zpScalars = {}
          for (const k of zpKeys) {
            const v = zp[k]
            if (v === null || typeof v !== 'object') zpScalars[k] = v
            else if (Array.isArray(v)) zpScalars[k] = `[array len=${v.length}]`
            else zpScalars[k] = `{object keys=${Object.keys(v).join(',')}}`
          }
          last.response = {
            status: resp.status(),
            totalCount: json?.zpData?.totalCount,
            jobListLength: json?.zpData?.jobList?.length,
            zpDataKeys: zpKeys,
            zpDataScalars: zpScalars,
            firstJob: json?.zpData?.jobList?.[0] ? `${json.zpData.jobList[0].jobName}@${json.zpData.jobList[0].brandName}` : '(empty)',
            secondJob: json?.zpData?.jobList?.[1] ? `${json.zpData.jobList[1].jobName}@${json.zpData.jobList[1].brandName}` : '(empty)',
            thirdJob: json?.zpData?.jobList?.[2] ? `${json.zpData.jobList[2].jobName}@${json.zpData.jobList[2].brandName}` : '(empty)',
          }
        } catch (e) {
          last.responseError = e?.message
        }
      }
    }
  })

  console.log(`🌐 打开 BOSS web search: ${USER_URL}\n`)
  await page.goto(USER_URL, { waitUntil: 'networkidle', timeout: 30000 }).catch((e) => {
    console.log(`⚠️ networkidle timeout: ${e.message}，继续`)
  })

  // 等几秒让 BOSS web 触发搜索请求（滚动 / 翻页可能触发多次）
  console.log('⏳ 等 5s 让 BOSS web 完整触发请求...')
  await new Promise(r => setTimeout(r, 5000))

  // 模拟滚到底部触发懒加载（如果 BOSS web 有）
  try {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    await new Promise(r => setTimeout(r, 2000))
  } catch (e) {}

  console.log(`\n📦 捕获到 ${captured.length} 个 search API 调用:\n`)
  if (captured.length === 0) {
    console.log('⚠️ 未捕获到任何 search API 调用 — BOSS web 可能用其他 endpoint 或不直接 fetch')
  }

  captured.forEach((c, i) => {
    console.log(`[${i + 1}]`)
    console.log(`  method:     ${c.method}`)
    console.log(`  url:        ${c.url}`)
    if (c.postData) {
      try {
        const parsed = JSON.parse(c.postData)
        console.log(`  postData:   ${JSON.stringify(parsed, null, 2)}`)
      } catch {
        console.log(`  postData:   ${c.postData}`)
      }
    } else {
      console.log(`  postData:   (none)`)
    }
    console.log(`  headers:    ${JSON.stringify(c.headers)}`)
    if (c.response) {
      console.log(`  response:   status=${c.response.status} totalCount=${c.response.totalCount} listLen=${c.response.jobListLength}`)
      console.log(`  zpDataKeys: ${JSON.stringify(c.response.zpDataKeys)}`)
      console.log(`  zpScalars:  ${JSON.stringify(c.response.zpDataScalars)}`)
      console.log(`  first3:     ${c.response.firstJob} | ${c.response.secondJob} | ${c.response.thirdJob}`)
    } else if (c.responseError) {
      console.log(`  response:   ERROR ${c.responseError}`)
    }
    console.log()
  })

  await browser.close()
}

main().catch((err) => {
  console.error('❌ 抓包失败:', err.message)
  process.exit(1)
})