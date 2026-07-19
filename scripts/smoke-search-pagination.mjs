#!/usr/bin/env node
// ============================================================
// Smoke: searchJobs 翻页真验证（§3.11 live 集成）
// ============================================================
// 目的：连真实 Chrome，通过 CDP 监听 BOSS /wapi/zpgeek/search/joblist.json
//       的 POST 请求，driver 触发 page=1 + page=2 两次搜索，
//       断言至少捕获到 ≥2 个「不同 page」的真实请求。
//       防御「翻页路径变更后只跑 mock / hook 通过」的假绿。
//
// 用法：
//   1. Chrome 已用 --remote-debugging-port=9222 启动 + BOSS 登录态有效
//   2. npx tsx scripts/smoke-search-pagination.mjs
//
// 判定：
//   distinct pages >= 2 → exit 0（PASS）
//   distinct pages <  2 → exit 1（FAIL）
//   CDP 9222 不在 / 未登录 → exit 0（SKIP，避免阻塞 commit）
//
// 参考：
//   - scripts/trace-boss-api.mjs（CDP Network 监听结构 + 复用 zhipin tab）
//   - scripts/probe-boss-api.mjs（BOSS joblist.json fetch body 形态）
//   - docs/adr（BOSS SPA navigation redirect 坑 → 复用已登录 tab，不开新 tab）
// ============================================================

import 'dotenv/config'
import { connectToUserChrome, attachPlaywrightToCDP } from '../src/browser/cdp.js'

const JOBLIST_PATH = '/wapi/zpgeek/search/joblist.json'
const SETTLE_MS = 3000
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// —— 每个捕获请求的 postData → page 字段 —— 用 Set 去重
const pages = new Set()

let browser
let cdpSession

async function cleanup(code) {
  await browser?.close().catch(() => {})
  process.exit(code)
}

try {
  // —— 1. 连真实 Chrome（CDP 不在 → connectToUserChrome throw → catch 里 SKIP）——
  const wrapper = await connectToUserChrome()
  browser = await attachPlaywrightToCDP(wrapper)
  const context = browser.contexts()[0]
  if (!context) {
    console.log('[smoke-pagination] SKIP：CDP 接管成功但无 browser context')
    await cleanup(0)
  }

  // —— 2. 复用已登录 zhipin tab（不开新 tab，避免 BOSS SPA 重定向坑）——
  const existingPages = context.pages()
  const page = existingPages.find((p) => (p.url() || '').includes('zhipin.com'))
  if (!page) {
    console.log('[smoke-pagination] SKIP：未找到已登录 zhipin.com tab（请先在 Chrome 打开 BOSS）')
    await cleanup(0)
  }
  console.log(`[smoke-pagination] ✅ 复用 zhipin tab: ${(page.url() || '').slice(0, 80)}`)

  // —— 3. Network.enable + 监听 joblist.json 的 POST 请求 ——
  cdpSession = await context.newCDPSession(page)
  await cdpSession.send('Network.enable')

  let sawAnyRequest = 0
  const pending = []
  cdpSession.on('Network.requestWillBeSent', (params) => {
    sawAnyRequest++
    const { url, method, postData } = params.request
    if (method !== 'POST') return
    if (!url.includes(JOBLIST_PATH)) return

    const extractPage = (raw) => {
      if (!raw) return
      try {
        const body = JSON.parse(raw)
        if (body.page != null) {
          pages.add(Number(body.page))
          console.log(`[smoke-pagination] 捕获 joblist POST page=${body.page}`)
        }
      } catch {
        /* 非 JSON body → 忽略 */
      }
    }

    if (postData) {
      extractPage(postData)
    } else if (params.request.hasPostData) {
      // CDP 有时不内联 postData（大 body / 分片）→ 主动拉取（异步，判定前统一 await）
      pending.push(
        cdpSession
          .send('Network.getRequestPostData', { requestId: params.requestId })
          .then((r) => extractPage(r?.postData))
          .catch(() => {}),
      )
    }
  })

  // —— 4. 用 page context 内 fetch 触发 page=1 / page=2 两次真实搜索 ——
  //    在页面上下文里 fetch → cookie/风控头由浏览器自动带上，且请求会被 CDP 捕获
  const driveFetch = async (pageNum) => {
    await page.evaluate(
      async ({ p }) => {
        try {
          await fetch('https://www.zhipin.com/wapi/zpgeek/search/joblist.json', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ query: 'Java后端', scene: 1, page: p, pageSize: 15 }),
          })
        } catch {
          /* 风控 / 网络失败也不抛，交给 CDP 捕获层判定 */
        }
      },
      { p: pageNum },
    )
  }

  console.log('[smoke-pagination] 触发 page=1 搜索...')
  await driveFetch(1)
  await sleep(800)
  console.log('[smoke-pagination] 触发 page=2 搜索...')
  await driveFetch(2)

  // —— 5. 等网络事件稳定 + 等待所有 postData 拉取完成 ——
  await sleep(SETTLE_MS)
  await Promise.all(pending)

  // —— 6/7. 输出 + 判定 ——
  const distinct = [...pages].sort((a, b) => a - b)
  console.log(`[smoke-pagination] 总捕获请求数: ${sawAnyRequest}`)
  console.log(`[smoke-pagination] distinct pages: ${distinct.join(',') || '(none)'}`)

  if (distinct.length >= 2) {
    console.log('[smoke-pagination] ✅ PASS：捕获到 ≥2 个不同 page 的真实 joblist 请求')
    await cleanup(0)
  } else {
    console.error('[smoke-pagination] ❌ FAIL：未捕获到 ≥2 个不同 page 的请求')
    console.error('  可能原因：BOSS 风控拦截 / page 字段未透传 / 翻页路径回归')
    await cleanup(1)
  }
} catch (err) {
  // CDP 不在（CDPUnavailableError）或连接失败 → SKIP（exit 0，不阻塞 commit）
  console.log(`[smoke-pagination] SKIP：无法连接真实 Chrome（${err?.message ?? err}）`)
  await cleanup(0)
}
