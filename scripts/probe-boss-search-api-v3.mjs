#!/usr/bin/env node
// ============================================================
// probe-boss-search-api-v3.mjs
// ============================================================
// 目的：
//   1. 补完 v2 race（case 2 / case 4）— retry + waitForLoadState
//   2. 翻 page 2/3 验证 user URL 过滤效果是否显著
//   3. 完整字段 dump（不截断）
//
// 测试矩阵：
//   1. baseline_empty                — 空 body（无 query 无 city）
//   2. baseline_city_only            — 仅 city=101210100
//   3. user_url_noquery              — user 原 URL 翻译到 body（无 query）
//   4. user_url_plus_query_Java      — user 原 URL + query='Java'
//   5. baseline_empty_page2          — baseline 翻 page 2
//   6. user_url_noquery_page2        — user URL 翻 page 2
//   7. baseline_empty_page3          — baseline 翻 page 3
//   8. user_url_noquery_page3        — user URL 翻 page 3
// ============================================================

import { chromium } from 'playwright-extra'

const CDP_URL = 'http://localhost:9222'
const API_URL = 'https://www.zhipin.com/wapi/zpgeek/search/joblist.json'

const USER_URL_QS = 'city=101210100&position=100101&jobType=1901&salary=406&experience=106&degree=203&industry=100020,100206,100804'

function qsToBody(qs, extra = {}) {
  const params = new URLSearchParams(qs)
  const body = { scene: 1, page: 1, pageSize: 20, ...extra }
  for (const [k, v] of params.entries()) {
    body[k] = /^\d+$/.test(v) ? Number(v) : v
  }
  return body
}

const tests = [
  ['1_baseline_empty',             { scene: 1, page: 1, pageSize: 20 }],
  ['2_baseline_city_only',         qsToBody('city=101210100')],
  ['3_user_url_noquery',           qsToBody(USER_URL_QS)],
  ['4_user_url_plus_query_Java',   qsToBody(USER_URL_QS, { query: 'Java' })],
  ['5_baseline_empty_page2',       { scene: 1, page: 2, pageSize: 20 }],
  ['6_user_url_noquery_page2',     qsToBody(USER_URL_QS, { page: 2 })],
  ['7_baseline_empty_page3',       { scene: 1, page: 3, pageSize: 20 }],
  ['8_user_url_noquery_page3',     qsToBody(USER_URL_QS, { page: 3 })],
]

async function fetchOnce(page, body, maxRetry = 2) {
  let lastErr
  for (let i = 0; i <= maxRetry; i++) {
    try {
      // race 防御：等 dom 稳定
      await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {})
      return await page.evaluate(async ({ url, body }) => {
        const r = await fetch(url, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        const json = await r.json()
        return { status: r.status, json }
      }, { url: API_URL, body })
    } catch (err) {
      lastErr = err
      if (i < maxRetry) {
        console.log(`  ↳ retry ${i + 1}/${maxRetry} after: ${err.message?.slice(0, 80)}`)
        await new Promise(r => setTimeout(r, 1500))
      }
    }
  }
  throw lastErr
}

async function main() {
  console.log('🔍 Probe BOSS search API v3 — 补 race + 翻页验证')
  console.log(`   USER URL QS: ${USER_URL_QS}\n`)

  const browser = await chromium.connectOverCDP(CDP_URL)
  const context = browser.contexts()[0]
  if (!context) throw new Error('CDP context 不存在')
  const page = context.pages().find((p) => (p.url() || '').includes('zhipin.com')) ?? context.pages()[0]
  if (!page) throw new Error('CDP context 无可用 page')

  console.log(`📌 复用 tab: ${page.url()}\n`)

  const results = []
  for (const [name, body] of tests) {
    try {
      const resp = await fetchOnce(page, body)
      const j = resp.json
      const total = j?.zpData?.totalCount ?? null
      const listLen = j?.zpData?.jobList?.length ?? 0
      const first = j?.zpData?.jobList?.[0]
      const firstJobStr = first ? `${first.jobName} @ ${first.brandName}` : '(empty)'
      const allJobs = (j?.zpData?.jobList ?? []).map((j, i) => `${i + 1}.${j.jobName}@${j.brandName}`).join(' | ')

      results.push({ name, body, status: resp.status, code: j?.code, message: j?.message, total, listLen, firstJob: firstJobStr, allJobs })

      console.log(`[${name}]`)
      console.log(`  body:    ${JSON.stringify(body)}`)
      console.log(`  status:  ${resp.status}`)
      console.log(`  code:    ${j?.code}  message: ${j?.message ?? ''}`)
      console.log(`  total:   ${total}  listLen: ${listLen}`)
      console.log(`  first:   ${firstJobStr}`)
      console.log(`  all:     ${allJobs}`)
      console.log()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.log(`[${name}] ERROR: ${msg.slice(0, 200)}\n`)
      results.push({ name, body, error: msg })
    }
  }

  // 总结
  console.log('='.repeat(70))
  console.log('📊 总结')
  console.log('='.repeat(70))
  for (const r of results) {
    if (r.error) {
      console.log(`  ${r.name.padEnd(35)} ❌ ${r.error.slice(0, 100)}`)
    } else {
      console.log(`  ${r.name.padEnd(35)} total=${String(r.total).padStart(4)}  listLen=${String(r.listLen).padStart(2)}  first=${r.firstJob}`)
    }
  }
  console.log()
  console.log('关键对比：')
  console.log('  • 1 vs 2 → city 单独是否生效（listLen 是否变？）')
  console.log('  • 3 vs 4 → query 叠加是否生效（listLen 是否变？）')
  console.log('  • 5 vs 6, 7 vs 8 → 翻 page 2/3，user URL 过滤效果是否显著？')

  await browser.close()
}

main().catch((err) => {
  console.error('❌ Probe 失败:', err.message)
  process.exit(1)
})