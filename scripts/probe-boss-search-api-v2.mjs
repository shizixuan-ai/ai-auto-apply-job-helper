#!/usr/bin/env node
// ============================================================
// probe-boss-search-api-v2.mjs
// ============================================================
// 目的：用 USER 原文 URL 验证（不拆参数 / 不加 query）
// 前置：probe-boss-search-api.mjs 拆参数实测不严谨，按 user 反馈重做
//
// 测试矩阵（按 §3.8 "不假设 / 单变量对比"）：
//   1. baseline_empty   — 空 body（无 query / 无 city / 无任何过滤）
//   2. baseline_city    — 仅 city=101210100（验证 city 独立生效）
//   3. user_url_noquery — 你原 URL 翻译到 body（无 query）
//   4. user_url_plus_query — 你原 URL + query='Java'
//
// 完整字段不截断（按 §3.8 调试纪律）
// ============================================================

import { chromium } from 'playwright-extra'

const CDP_URL = 'http://localhost:9222'
const API_URL = 'https://www.zhipin.com/wapi/zpgeek/search/joblist.json'

/** user 原文 URL 的 querystring（逐字照搬） */
const USER_URL_QS = 'city=101210100&position=100101&jobType=1901&salary=406&experience=106&degree=203&industry=100020,100206,100804'

/** 把 querystring 翻译到 API body（保留字符串 / 数字原样） */
function qsToBody(qs, extra = {}) {
  const params = new URLSearchParams(qs)
  const body = { scene: 1, page: 1, pageSize: 20, ...extra }
  for (const [k, v] of params.entries()) {
    // 数字尝试转换（BOSS API 多数是数字 code）
    body[k] = /^\d+$/.test(v) ? Number(v) : v
  }
  return body
}

const tests = [
  ['1_baseline_empty',             { scene: 1, page: 1, pageSize: 20 }],
  ['2_baseline_city_only',         qsToBody('city=101210100')],
  ['3_user_url_noquery',           qsToBody(USER_URL_QS)],
  ['4_user_url_plus_query_Java',   qsToBody(USER_URL_QS, { query: 'Java' })],
]

async function main() {
  console.log('🔍 Probe BOSS search API v2 — 用 USER 原文 URL')
  console.log(`   CDP: ${CDP_URL}`)
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
      const resp = await page.evaluate(async ({ url, body }) => {
        const r = await fetch(url, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        const json = await r.json()
        return { status: r.status, json }
      }, { url: API_URL, body })

      const j = resp.json
      const total = j?.zpData?.totalCount ?? null
      const listLen = j?.zpData?.jobList?.length ?? 0
      const first = j?.zpData?.jobList?.[0]
      const firstJobStr = first ? `${first.jobName} @ ${first.brandName}` : '(empty)'

      results.push({ name, body, status: resp.status, code: j?.code, message: j?.message, total, listLen, firstJob: firstJobStr })

      console.log(`[${name}]`)
      console.log(`  body:    ${JSON.stringify(body)}`)
      console.log(`  status:  ${resp.status}`)
      console.log(`  code:    ${j?.code}  message: ${j?.message ?? ''}`)
      console.log(`  total:   ${total}  jobList.length: ${listLen}`)
      console.log(`  first:   ${firstJobStr}`)
      console.log()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.log(`[${name}] ERROR: ${msg}\n`)
      results.push({ name, body, error: msg })
    }
  }

  // 对比
  console.log('='.repeat(60))
  console.log('📊 总结 — 4 个 case 对比')
  console.log('='.repeat(60))
  for (const r of results) {
    if (r.error) {
      console.log(`  ${r.name.padEnd(35)} ❌ ERROR: ${r.error}`)
    } else {
      console.log(`  ${r.name.padEnd(35)} total=${String(r.total).padStart(4)}  listLen=${String(r.listLen).padStart(2)}  first=${r.firstJob}`)
    }
  }

  await browser.close()
}

main().catch((err) => {
  console.error('❌ Probe 失败:', err.message)
  process.exit(1)
})