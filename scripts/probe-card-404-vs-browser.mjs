#!/usr/bin/env node
// ============================================================
// probe-card-404-vs-browser.mjs — Node fetch vs 浏览器 fetch 对照
// ============================================================
// 探针 #1 (probe-card-404-retry.mjs) 关键发现：
//   Node fetch + context.cookies() header → 3/3 立即 200
//   src/browser/index.ts 走 page.evaluate(fetch + credentials:include) → 404
//   同一 URL + 同一 cookies + 同一 securityId，唯一变量是 fetch 执行环境
//
// 目的：隔离变量。在同一次 probe 内同时跑 Node fetch 和 浏览器 fetch，
//   确认 browser fetch 路径是不是真的有 bug。
//
// 用法：
//   1. Chrome --remote-debugging-port=9222 + 已登录 BOSS
//   2. npx tsx scripts/probe-card-404-vs-browser.mjs "Java"
//
// 对照设计：
//   每个 job 跑 3 次：
//     [A] Node fetch + cookie header      (复刻 probe-boss-api.mjs 模式)
//     [B] page.evaluate(fetch, creds:include)  (复刻 fetchJobDetailViaWapi 模式)
//     [C] page.evaluate(fetch, creds:include, +Referer)  (有 Referer，看是否影响)
//
// 如果 A 全过 B 全败：浏览器 fetch 路径有 bug（same-origin / cookie scope）
// 如果都过：bug 不在 fetch，是 fetchJobDetail 调用时机问题（page navigation race）
// ============================================================

import 'dotenv/config'
import { connectToUserChrome, attachPlaywrightToCDP } from '../src/browser/cdp.js'

const keyword = process.argv[2] || 'Java'

console.log(`[probe] 启动 CDP + 接管用户真 Chrome`)
console.log(`[probe] 关键词: "${keyword}"`)
console.log(`[probe] 每个 job 跑 3 路对照:`)
console.log(`  [A] Node fetch (header Cookie)`)
console.log(`  [B] 浏览器 fetch (page.evaluate, credentials:include)`)
console.log(`  [C] 浏览器 fetch + Referer: https://www.zhipin.com/web/geek/recommend`)

const cardUrl = (lid, securityId) =>
  `https://www.zhipin.com/wapi/zpgeek/job/card.json?lid=${encodeURIComponent(lid)}&securityId=${encodeURIComponent(securityId)}&sessionId=`

try {
  const wrapper = await connectToUserChrome()
  const browser = await attachPlaywrightToCDP(wrapper)
  const context = browser.contexts()[0]
  if (!context) throw new Error('CDP 接管成功但未找到 browser context')

  // 找到已在的 zhipin tab（src 用 pickZhipinTabOrNew 同样的逻辑）
  const pages = context.pages()
  const zhipinPage = pages.find((p) => (p.url() || '').includes('zhipin.com'))
  if (!zhipinPage) {
    throw new Error('未找到已打开的 zhipin.com tab — 请在 Chrome 里打开 BOSS')
  }
  console.log(`[probe] 复用 zhipin tab: ${zhipinPage.url()}`)
  console.log(`[probe] 当前 page origin: ${new URL(zhipinPage.url()).origin}`)

  const cookies = await context.cookies('https://www.zhipin.com')
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ')
  console.log(`[probe] 拿到 ${cookies.length} 个 BOSS cookies`)

  // 关键差异点：probe #2 用的 page 是已存在的 /job_detail/...，但 live bapply search
  //   在 search 阶段会 page.goto('/web/geek/recommend')，page state 不同。
  //   Sprint 2026-07-23 加 page.goto 模拟 search 后的真实 page state。
  console.log(`\n[probe] ⚠️  模拟 search 阶段 page.goto('/web/geek/recommend')，让 page state 接近 live`)
  await zhipinPage.goto('https://www.zhipin.com/web/geek/recommend', { waitUntil: 'domcontentloaded' })
  console.log(`[probe] page.goto 后 URL: ${zhipinPage.url()}`)

  // search
  console.log(`\n[probe] === search 拿前 3 个 job ===`)
  const searchResp = await fetch('https://www.zhipin.com/wapi/zpgeek/search/joblist.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
    body: JSON.stringify({ query: keyword, scene: 1, page: 1, pageSize: 5 }),
  })
  const searchData = await searchResp.json()
  if (searchData.code !== 0) throw new Error(`search code=${searchData.code}`)
  const jobs = searchData.zpData.jobList.slice(0, 3)
  console.log(`[probe] 拿到 ${searchData.zpData.jobList.length} 个 job`)

  // 3 路对照
  console.log(`\n[probe] === 3 路对照 ===`)
  for (const job of jobs) {
    console.log(`\n[probe] ---------- ${job.jobName} (lid=${job.lid}) ----------`)

    // [A] Node fetch
    try {
      const resp = await fetch(cardUrl(job.lid, job.securityId), {
        headers: { Cookie: cookieHeader, Accept: 'application/json' },
      })
      const body = await resp.text()
      console.log(`[A] Node fetch:        HTTP ${resp.status} | body ${body.length}字节 | ${body.slice(0, 100)}`)
    } catch (err) {
      console.log(`[A] Node fetch:        THROW ${err.message}`)
    }

    // [B] 浏览器 fetch, credentials:include（src 模式）
    try {
      const bResult = await zhipinPage.evaluate(
        async ({ url }) => {
          try {
            const resp = await fetch(url, {
              credentials: 'include',
              headers: { Accept: 'application/json' },
            })
            const text = await resp.text()
            return { ok: resp.ok, status: resp.status, body: text }
          } catch (e) {
            return { ok: false, status: 0, throw: e?.message ?? String(e) }
          }
        },
        { url: cardUrl(job.lid, job.securityId) },
      )
      if (bResult.throw) {
        console.log(`[B] 浏览器 fetch:      THROW ${bResult.throw}`)
      } else {
        console.log(`[B] 浏览器 fetch:      HTTP ${bResult.status} | body ${bResult.body.length}字节 | ${bResult.body.slice(0, 100)}`)
      }
    } catch (err) {
      console.log(`[B] 浏览器 fetch:      evaluate 自身抛: ${err.message}`)
    }

    // [C] 浏览器 fetch + Referer（探索）
    try {
      const cResult = await zhipinPage.evaluate(
        async ({ url }) => {
          try {
            const resp = await fetch(url, {
              credentials: 'include',
              headers: {
                Accept: 'application/json',
                Referer: 'https://www.zhipin.com/web/geek/recommend',
              },
            })
            const text = await resp.text()
            return { ok: resp.ok, status: resp.status, body: text }
          } catch (e) {
            return { ok: false, status: 0, throw: e?.message ?? String(e) }
          }
        },
        { url: cardUrl(job.lid, job.securityId) },
      )
      if (cResult.throw) {
        console.log(`[C] 浏览器+Referer:    THROW ${cResult.throw}`)
      } else {
        console.log(`[C] 浏览器+Referer:    HTTP ${cResult.status} | body ${cResult.body.length}字节 | ${cResult.body.slice(0, 100)}`)
      }
    } catch (err) {
      console.log(`[C] 浏览器+Referer:    evaluate 自身抛: ${err.message}`)
    }
  }

  console.log(`\n[probe] === 完成 ===`)
  console.log(`[probe] 👉 看输出判断：`)
  console.log(`   - A 过 B 败：浏览器 fetch 路径有 cookie/same-origin 问题`)
  console.log(`   - A 过 B 过 C 过：bug 在 fetchJobDetail 调用时机（page navigation race）`)
  console.log(`   - 全败：securityId / cookie 真有问题（探针 #1 已证伪，所以不会是这）`)

  await browser.close().catch(() => {})
} catch (err) {
  console.error(`\n[probe] ❌ 失败: ${err.message}`)
  console.error(err.stack)
  process.exit(1)
}
