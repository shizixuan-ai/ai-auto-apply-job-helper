#!/usr/bin/env node
// ============================================================
// BOSS API Trace — 不打开 DevTools 捕获真实 wapi 调用
// ============================================================
// 目的：用 CDP Network 域事件订阅，在不开 DevTools UI 的前提下
//       捕获 BOSS 页面真实发起的 wapi 调用（特别是 joblist.json 的 body）
//
// 优势 vs 打开 DevTools Network：
//   - 不触发 BOSS 的 DevTools 检测（patas.js 不感知）
//   - 持久化到 JSONL 文件，便于事后分析
//   - Node 端零侵入，不污染 page context
//
// 用法：
//   1. Chrome 已用 --remote-debugging-port=9222 启动 + BOSS 登录态有效
//   2. npx tsx scripts/trace-boss-api.mjs
//   3. 在 Chrome 中手动操作 BOSS（搜索 / 加筛选 / 看详情）
//   4. 默认 60s 后自动退出，或 Ctrl+C 提前结束
//   5. 终端实时打印 + tests/fixtures/cdp-trace-<ts>.jsonl 持久化
// ============================================================

import 'dotenv/config'
import { connectToUserChrome, attachPlaywrightToCDP } from '../src/browser/cdp.js'
import { writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'

const TIMEOUT_MS = Number(process.env.BOSS_TRACE_TIMEOUT_MS ?? 60_000)
const ONLY_WAPI = process.env.BOSS_TRACE_ONLY_WAPI !== '0'

console.log(`[trace] 启动 CDP 接管 (port=${process.env.BOSS_CDP_PORT ?? 9222})`)

let browser, cdpSession, traceFile
let wapiCount = 0
let allCount = 0

try {
  const wrapper = await connectToUserChrome()
  browser = await attachPlaywrightToCDP(wrapper)
  const context = browser.contexts()[0]
  if (!context) throw new Error('未找到 browser context（请确认 Chrome 已开窗口）')

  // 复用现有已登录 zhipin tab（不开新 tab）——
  //   新 tab 导航到 /web/geek/jobs 会被 BOSS SPA 当作"直接进入"重定向到登录/首页
  //   （同 src/browser/index.ts searchJobs Phase 1 记录的 SPA navigation redirect 坑）
  const existingPages = context.pages()
  let page = existingPages.find((p) => (p.url() || '').includes('zhipin.com'))
  if (page) {
    console.log(`[trace] ✅ 复用现有 zhipin tab: ${(page.url() || '').slice(0, 80)}`)
  } else {
    console.log('[trace] ⚠️ 未找到 zhipin tab，开新 tab（可能被重定向，建议先在 Chrome 打开 BOSS 再重跑）')
    page = await context.newPage()
  }
  cdpSession = await context.newCDPSession(page)
  await cdpSession.send('Network.enable')

  traceFile = resolve(
    process.cwd(),
    `tests/fixtures/cdp-trace-${Date.now()}.jsonl`,
  )
  mkdirSync(dirname(traceFile), { recursive: true })
  // 写 header line（区分文件格式）
  writeFileSync(
    traceFile,
    JSON.stringify({
      _meta: {
        capturedAt: new Date().toISOString(),
        method: 'CDP Network.requestWillBeSent + responseReceived',
        note: '非侵入式监听，不打开 DevTools UI',
        bcdpPort: process.env.BOSS_CDP_PORT ?? 9222,
      },
    }) + '\n',
  )

  console.log(`[trace] 输出文件: ${traceFile}`)
  console.log(`[trace] 模式: ${ONLY_WAPI ? '仅 wapi/*' : '全部 zhipin.com'}`)
  console.log(`[trace] 超时: ${TIMEOUT_MS / 1000}s（按 Ctrl+C 提前退出）`)
  console.log(`[trace] 就绪 → 在 Chrome 中操作 BOSS...`)

  cdpSession.on('Network.requestWillBeSent', (params) => {
    const url = params.request.url
    if (!url.includes('zhipin.com')) return
    if (ONLY_WAPI && !url.includes('/wapi/zpgeek/')) return

    const entry = {
      ts: new Date().toISOString(),
      type: 'request',
      method: params.request.method,
      url,
      postData: params.request.postData,
      initiator: params.initiator?.type,
      stack: params.initiator?.stack?.callFrames?.[0],
    }

    if (url.includes('/wapi/zpgeek/')) {
      wapiCount++
      console.log(`\n[${wapiCount}] ${entry.method} ${url.replace('https://www.zhipin.com', '')}`)
      if (entry.postData) {
        const body = entry.postData
        console.log(`    body (${body.length} chars): ${body.slice(0, 500)}${body.length > 500 ? '...' : ''}`)
      }
    }
    allCount++
    appendFileSync(traceFile, JSON.stringify(entry) + '\n')
  })

  cdpSession.on('Network.responseReceived', (params) => {
    const url = params.response.url
    if (!url.includes('zhipin.com')) return
    if (ONLY_WAPI && !url.includes('/wapi/zpgeek/')) return

    const entry = {
      ts: new Date().toISOString(),
      type: 'response',
      url,
      status: params.response.status,
      mime: params.response.mimeType,
      fromCache: params.response.fromDiskCache || params.response.fromServiceWorker,
    }

    if (url.includes('/wapi/zpgeek/')) {
      console.log(`    ← ${entry.status} ${entry.mime}${entry.fromCache ? ' (cache)' : ''}`)
    }
    appendFileSync(traceFile, JSON.stringify(entry) + '\n')
  })

  cdpSession.on('Network.loadingFailed', (params) => {
    if (params.type !== 'XHR' && params.type !== 'Fetch') return
    const entry = {
      ts: new Date().toISOString(),
      type: 'failed',
      errorText: params.errorText,
      type2: params.type,
    }
    console.log(`    ❌ failed: ${params.errorText} (${params.type})`)
    appendFileSync(traceFile, JSON.stringify(entry) + '\n')
  })

  // 自动超时退出
  setTimeout(async () => {
    console.log(`\n[trace] 超时 ${TIMEOUT_MS / 1000}s 自动退出`)
    await cleanup()
  }, TIMEOUT_MS)
} catch (err) {
  console.error(`[trace] ❌ 启动失败: ${err.message}`)
  console.error(`排查:`)
  console.error(`  1. Chrome 是否已用 --remote-debugging-port=9222 启动？`)
  console.error(`  2. 端口 9222 是否被占用？lsof -i :9222`)
  console.error(`  3. BOSS 是否已登录（任意 zhipin.com 页面）？`)
  process.exit(1)
}

async function cleanup() {
  console.log(`\n[trace] 汇总: wapi 调用 ${wapiCount} 个 / 全部 zhipin 调用 ${allCount} 个`)
  console.log(`[trace] 输出文件: ${traceFile}`)
  await browser?.close().catch(() => {})
  process.exit(0)
}

process.on('SIGINT', () => {
  console.log('\n[trace] Ctrl+C 收到')
  cleanup()
})