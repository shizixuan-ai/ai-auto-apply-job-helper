#!/usr/bin/env node
// ============================================================
// probe-boss-search-api.mjs
// ============================================================
// 目的：验证 BOSS search API 对 6 个过滤参数的支持情况
//       (position / jobType / salary / experience / degree / industry)
// 用法：node scripts/probe-boss-search-api.mjs
// 前置：Chrome 已用 --remote-debugging-port=9222 启动
//       （src/cli/index.ts:23 + src/browser/cdp.ts 约定）
//
// 输出格式：每个 case 一段，含 body + status + code + totalCount + listLen + firstJob
// 完整字段不截断（按 §3.8 调试纪律）
//
// 多假设树（§3.8 / ≥3 独立）：
//   H1: API 不支持 → 响应与 baseline 一致
//   H2: API 支持但字段名不同（positionCode / industryCodes）
//   H3: API 支持但要嵌套结构（filter.position）
//   H4: industry 多值格式（string / strArr / numArr）只有一种生效
// ============================================================

import { chromium } from 'playwright-extra'

const CDP_URL = 'http://localhost:9222'
const API_URL = 'https://www.zhipin.com/wapi/zpgeek/search/joblist.json'

/** baseline 参照 — 已知 search API 接受的最小字段 */
const baseline = {
  query: 'Java',
  city: 101210100, // 杭州（与 user URL 一致）
  scene: 1,
  page: 1,
  pageSize: 20,
}

/** 10 个测试 case — 覆盖 H1/H2/H3/H4 */
const tests = [
  ['0_baseline',                                   baseline],
  ['1_+position=100101',                           { ...baseline, position: '100101' }],
  ['2_+jobType=1901',                              { ...baseline, jobType: '1901' }],
  ['3_+salary=406',                                { ...baseline, salary: '406' }],
  ['4_+experience=106',                            { ...baseline, experience: '106' }],
  ['5_+degree=203',                                { ...baseline, degree: '203' }],
  ['6a_+industry="str" (string)',                  { ...baseline, industry: '100020,100206,100804' }],
  ['6b_+industryCodes="strArr"',                   { ...baseline, industryCodes: ['100020', '100206', '100804'] }],
  ['6c_+industry=[num] (numArr)',                  { ...baseline, industry: [100020, 100206, 100804] }],
  ['7_+filter={...} (nested)',                     { ...baseline, filter: { position: 100101, jobType: '1901' } }],
]

async function main() {
  console.log('🔍 Probe BOSS search API — 验证 6 个过滤参数支持情况')
  console.log(`   CDP: ${CDP_URL}`)
  console.log(`   API: ${API_URL}`)
  console.log(`   baseline query=Java city=杭州(101210100)\n`)

  const browser = await chromium.connectOverCDP(CDP_URL)
  const context = browser.contexts()[0]
  if (!context) {
    throw new Error('CDP 接管成功但未找到 context — Chrome 至少要打开过一个窗口')
  }
  // 复用已有 zhipin tab（带真实 cookie + Referer）
  const page = context.pages().find((p) => (p.url() || '').includes('zhipin.com')) ?? context.pages()[0]
  if (!page) {
    throw new Error('CDP context 没有可用 page — 请在 Chrome 打开至少一个 tab')
  }

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

  // 总结：baseline vs 其他，totalCount / listLen 是否变化？
  console.log('='.repeat(60))
  console.log('📊 总结 — 各 case vs baseline 对比')
  console.log('='.repeat(60))
  const b = results[0]
  console.log(`baseline total=${b.total}, listLen=${b.listLen}\n`)
  for (const r of results.slice(1)) {
    const dT = r.total != null && b.total != null ? r.total - b.total : 'N/A'
    const dL = r.listLen != null && b.listLen != null ? r.listLen - b.listLen : 'N/A'
    const totalChanged = dT !== 0 && dT !== 'N/A'
    const listChanged = dL !== 0 && dL !== 'N/A'
    const verdict = totalChanged || listChanged ? '✅ 生效' : '⚠️ 无变化（可能不支持 / 字段名错）'
    console.log(`  ${r.name.padEnd(46)} total=${String(r.total).padStart(4)} (Δ${String(dT).padStart(3)})  listLen=${String(r.listLen).padStart(2)} (Δ${String(dL).padStart(3)})  ${verdict}`)
  }

  await browser.close()
}

main().catch((err) => {
  console.error('❌ Probe 失败:', err.message)
  process.exit(1)
})