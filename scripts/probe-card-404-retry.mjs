#!/usr/bin/env node
// ============================================================
// probe-card-404-retry.mjs — 验证 live "404 status code (no body)"
// ============================================================
// 背景（2026-07-23）：
//   live `bapply search` 5/5 job 全 "failed: 404 status code (no body)"
//   ADR-0014 §6 已记录，标"securityId 失效 / URL 模板错"
//   单测 mock {status:404} 通过 → live retry 仍然 404（fetch throw status:0）
//
// 目的：用真实 BOSS API 回答 3 个问题：
//   Q1: search 拿到 lid+securityId 后，**立即**调 card.json 返什么？
//       (HTTP 404? fetch throw? BOSS code X? 完整 body 是啥?)
//   Q2: 等 5s 后再调 → 还 404 吗？
//   Q3: 等 15s / 30s 后再调 → 啥时候成功（如果能成功）？
//
// 用法：
//   1. Chrome --remote-debugging-port=9222 启动 + 已登录 BOSS
//   2. node scripts/probe-card-404-retry.mjs "Java"
//   3. 看输出：每个时间点的真实 status + body + 是否 throw
//
// 关键修法（参考 probe-boss-api.mjs v3）：context.cookies() + Node fetch
//   无 page 操作，无 navigation 干扰——直接观测 BOSS 后端真实行为。
// ============================================================

import 'dotenv/config'
import { connectToUserChrome, attachPlaywrightToCDP } from '../src/browser/cdp.js'

const keyword = process.argv[2] || 'Java'
const RETRY_DELAYS_MS = [0, 5_000, 15_000, 30_000] // T0 / +5s / +15s / +30s

console.log(`[probe] 启动 CDP + 接管用户真 Chrome`)
console.log(`[probe] 关键词: "${keyword}"`)
console.log(`[probe] 重试时间点(ms): ${RETRY_DELAYS_MS.join(', ')}`)
console.log(`[probe] 用 context.cookies() + Node fetch（绕过 page navigation）`)

/**
 * 调一次 card.json，**完整**记录结果（含 body 内容 / throw 类型）
 * 这是关键——上次 src 改 retry 的 bug 根因就是没读 body，不知道 throw vs resp.ok=false 的区别
 */
async function callCardJson(cookieHeader, lid, securityId, label) {
  const url = `https://www.zhipin.com/wapi/zpgeek/job/card.json?lid=${encodeURIComponent(lid)}&securityId=${encodeURIComponent(securityId)}&sessionId=`
  console.log(`\n[probe] [${label}] → ${url.slice(0, 80)}...`)
  try {
    const resp = await fetch(url, {
      headers: {
        Cookie: cookieHeader,
        Accept: 'application/json',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
      },
    })
    const status = resp.status
    const text = await resp.text()
    const bodyPreview = text.slice(0, 200)
    console.log(`[probe] [${label}] HTTP ${status} | body (${text.length} 字节): ${bodyPreview}`)
    return { ok: resp.ok, status, body: text }
  } catch (err) {
    console.log(`[probe] [${label}] THROW: ${err.constructor.name}: ${err.message}`)
    return { ok: false, status: 0, body: '', throw: err.message }
  }
}

try {
  const wrapper = await connectToUserChrome()
  const browser = await attachPlaywrightToCDP(wrapper)
  const context = browser.contexts()[0]
  if (!context) {
    throw new Error('CDP 接管成功但未找到 browser context')
  }

  const cookies = await context.cookies('https://www.zhipin.com')
  if (cookies.length === 0) {
    throw new Error('未找到 zhipin.com cookies — 请先 bapply login')
  }
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ')
  console.log(`[probe] 拿到 ${cookies.length} 个 BOSS cookies`)

  // Step 1: search 拿 lid+securityId（新鲜出炉）
  console.log(`\n[probe] === Step 1: search joblist.json 拿首个 job 的 lid+securityId ===`)
  const searchResp = await fetch('https://www.zhipin.com/wapi/zpgeek/search/joblist.json', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookieHeader,
      'User-Agent': 'Mozilla/5.0 ... Safari/537.36',
    },
    body: JSON.stringify({ query: keyword, scene: 1, page: 1, pageSize: 5 }),
  })
  const searchData = await searchResp.json()
  if (searchData.code !== 0 || !searchData.zpData?.jobList?.length) {
    throw new Error(`search 失败: code=${searchData.code} message=${searchData.message}`)
  }

  // 拿前 3 个 job 都试（避免单个 job 的 special case）
  const jobs = searchData.zpData.jobList.slice(0, 3)
  console.log(`[probe] 拿到 ${searchData.zpData.jobList.length} 个 job，前 ${jobs.length} 个用于探针`)

  // Step 2: 对每个 job，按 RETRY_DELAYS_MS 时间序列调 card.json
  console.log(`\n[probe] === Step 2: 每个 job 按时间点调 card.json ===`)
  for (const job of jobs) {
    console.log(`\n[probe] ---------- job: ${job.jobName} (id=${job.encryptJobId}) ----------`)
    console.log(`[probe] lid=${job.lid}`)
    console.log(`[probe] securityId=${job.securityId?.slice(0, 30)}...`)
    console.log(`[probe] ⚠️ securityId 完整长度=${job.securityId?.length} 字符`)

    let lastCallTime = Date.now()
    for (const delayMs of RETRY_DELAYS_MS) {
      const wait = delayMs - (Date.now() - lastCallTime)
      if (wait > 0) {
        console.log(`\n[probe] ⏳ 等 ${wait}ms ...`)
        await new Promise((r) => setTimeout(r, wait))
      }
      const elapsedMs = Date.now() - lastCallTime
      const result = await callCardJson(cookieHeader, job.lid, job.securityId, `+${elapsedMs}ms`)
      if (result.ok && result.status === 200) {
        // 成功！打印 postDescription 长度证明是真 JD
        try {
          const data = JSON.parse(result.body)
          const jd = data?.zpData?.jobCard?.postDescription
          console.log(`[probe] [${`+${elapsedMs}ms`}] ✅ 成功! zpData.jobCard.postDescription 长度=${jd?.length ?? 0}`)
        } catch {
          console.log(`[probe] [+${elapsedMs}ms] ✅ HTTP 200 但 body 不是 JSON`)
        }
        // 成功后跳过后续重试
        break
      }
    }
  }

  console.log(`\n[probe] === 探针完成 ===`)
  console.log(`[probe] 👉 下一步根据真实数据决定：`)
  console.log(`   - 若 +0ms 就 200：securityId 没问题，是 src 端 fetch 路径问题`)
  console.log(`   - 若 +0ms 失败但 +Xms 成功：securityId 真有 TTL，X 是临界值`)
  console.log(`   - 若全部失败：securityId / cookie / URL 模板 三选一要查`)

  await browser.close().catch(() => {})
} catch (err) {
  console.error(`\n[probe] ❌ 失败: ${err.message}`)
  console.error(err.stack)
  process.exit(1)
}
