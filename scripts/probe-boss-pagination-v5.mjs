#!/usr/bin/env node
// ============================================================
// probe-boss-pagination-v5.mjs
// ============================================================
// 目的：用 CDP 原生 Network.enable 监听请求（不触发 Playwright runtime）
// 关键：完全不调用 page.evaluate / page.click / page.goto
// 滚动：用 CDP 原生 Input.dispatchMouseEvent（mouseWheel）— 模拟真实用户滚动
//
// 为什么 V1 应该不被风控：
// - context.cookies() + Node fetch（probe-boss-api.mjs 模式）已证明不被风控
// - V1 不调用任何 page.* 方法（不触发 Playwright runtime 注入）
// - 滚动用 CDP 原生 Input.dispatchMouseEvent（底层命令，不通过 page 上下文）
// ============================================================

import { chromium } from 'playwright-extra'

const CDP_URL = 'http://localhost:9222'
const TARGET_HOST = '/web/geek/jobs'

async function main() {
  const browser = await chromium.connectOverCDP(CDP_URL)
  const context = browser.contexts()[0]

  const pages = context.pages()
  console.log(`📋 Chrome tabs: ${pages.length}`)
  pages.forEach((p, i) => console.log(`  [${i + 1}] ${p.url()?.slice(0, 100)}`))

  const searchPage = pages.find((p) => (p.url() || '').includes(TARGET_HOST))
  if (!searchPage) {
    console.log(`❌ 没找到 ${TARGET_HOST}`)
    await browser.close()
    return
  }
  console.log(`\n✅ BOSS 搜索页: ${searchPage.url()}\n`)

  // 拿到 CDPSession（Playwright 提供的底层 CDP 接口）
  const cdpSession = await context.newCDPSession(searchPage)
  console.log('✅ CDPSession 拿到')

  // 用 Network.enable 监听（CDP 原生命令）
  await cdpSession.send('Network.enable')
  console.log('✅ Network.enable 已发\n')

  const captured = []
  cdpSession.on('Network.requestWillBeSent', (params) => {
    const url = params.request.url
    if (url.includes('zhipin.com')) {
      captured.push({
        requestId: params.requestId,
        method: params.request.method,
        url,
        postData: params.request.postData,
        ts: Date.now(),
        type: params.type,
        initiator: params.initiator?.type,
      })
    }
  })
  cdpSession.on('Network.responseReceived', (params) => {
    const url = params.response.url
    if (url.includes('zhipin.com')) {
      const last = [...captured].reverse().find((c) => c.requestId === params.requestId && !c.response)
      if (last) {
        last.response = {
          status: params.response.status,
          mimeType: params.response.mimeType,
        }
      }
    }
  })
  cdpSession.on('Network.loadingFinished', async (params) => {
    const last = [...captured].reverse().find((c) => c.requestId === params.requestId && !c.body)
    if (last && last.response?.mimeType?.includes('json')) {
      try {
        const { body, base64Encoded } = await cdpSession.send('Network.getResponseBody', { requestId: params.requestId })
        const text = base64Encoded ? Buffer.from(body, 'base64').toString('utf-8') : body
        try {
          const json = JSON.parse(text)
          last.body = {
            listLen: json?.zpData?.jobList?.length,
            totalCount: json?.zpData?.totalCount,
            hasLastId: json?.zpData ? ('lastId' in json.zpData || 'last_id' in json.zpData || 'cursor' in json.zpData) : false,
            lastIdValue: json?.zpData?.lastId ?? json?.zpData?.last_id ?? json?.zpData?.cursor ?? null,
            zpDataKeys: json?.zpData ? Object.keys(json.zpData).slice(0, 20) : [],
            firstJob: json?.zpData?.jobList?.[0] ? `${json.zpData.jobList[0].jobName}@${json.zpData.jobList[0].brandName}` : '(empty)',
          }
        } catch {
          last.bodyError = 'not json'
        }
      } catch (e) {
        last.bodyError = e?.message?.slice(0, 100)
      }
    }
  })

  console.log(`📍 接管后 page.url() = ${searchPage.url()}`)
  console.log(`📍 接管后 page.title() = ${await searchPage.title().catch(() => 'N/A')}\n`)

  // 用 CDP 原生 Input.dispatchMouseEvent 模拟滚动（不触发 page.evaluate runtime）
  console.log(`📜 用 CDP 原生 Input.dispatchMouseEvent 滚动 4 次...\n`)
  for (let i = 0; i < 4; i++) {
    try {
      await cdpSession.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: 640,
        y: 400,
        deltaX: 0,
        deltaY: 1000,
      })
      await new Promise(r => setTimeout(r, 2500))
      console.log(`  scroll ${i + 1}/4 done — page.url()=${searchPage.url()?.slice(0, 80)}`)
    } catch (e) {
      console.log(`  scroll ${i + 1}/4 ERROR: ${e.message?.slice(0, 100)}`)
    }
  }

  await new Promise(r => setTimeout(r, 3000))

  console.log(`\n📦 共捕获到 ${captured.length} 个 BOSS API 调用\n`)

  // 找含 jobList 的调用
  const jobListCalls = captured.filter((c) => c.body?.listLen > 0)
  console.log(`\n🎯 含 jobList 的 API 调用: ${jobListCalls.length}\n`)

  if (jobListCalls.length === 0) {
    console.log(`⚠️ 没抓到 search 类 API`)
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
      console.log(`  resp:    status=${c.response?.status} listLen=${c.body?.listLen} totalCount=${c.body?.totalCount}`)
      console.log(`  hasLastId: ${c.body?.hasLastId}  lastId/cursor: ${c.body?.lastIdValue}`)
      console.log(`  zpData keys: ${c.body?.zpDataKeys?.join(', ')}`)
      console.log(`  firstJob:   ${c.body?.firstJob}\n`)
    })
  }

  console.log(`\n📍 结束后 page.url() = ${searchPage.url()}\n`)
}

main().catch((err) => {
  console.error('❌ 抓包失败:', err.message)
  process.exit(1)
})