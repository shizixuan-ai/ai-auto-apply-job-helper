#!/usr/bin/env node
// ============================================================
// probe-boss-filter-codes.mjs
// ============================================================
// 目的：dump BOSS 搜索筛选器的完整码表（salary/experience/degree/jobType 等
//       code → 中文label 映射），解决 --salary 406 到底是啥的问题。
//
// 背景：DEEP probe 只拿到 code（406/106/203/1901），不知道含义 + 没有全量选项。
//       实测发现 salary=406 结果薪资跨度很宽 → 怀疑码含义与假设不符。
//
// 反爬约束（承接 v5 的教训 / feedback_boss_anti_bot_status）：
//   - 不用 Playwright page.evaluate（会注入 Playwright runtime，可能被 patas.js 检测）
//   - 用 CDP 原生 Runtime.evaluate + Network.enable（底层命令，羊皮原则低风险）
//
// 多路探测（不猜码表放哪，3 个候选源全 dump，跑完看哪个有货）：
//   A. Network：捕获 wapi 响应，flag URL 含 condition/filter/common/dict/position 的
//   B. Runtime：扫全局 JS state（__NUXT__/__INITIAL_STATE__ 等）里的 {code,name} 数组
//   C. Runtime：扫 DOM 里带 data-val/data-value 属性 或 href 含 salary=/experience= 的元素
//
// 用法：
//   1. Chrome --remote-debugging-port=9222 + BOSS 登录态 + 停在 /web/geek/jobs
//   2. npx tsx scripts/probe-boss-filter-codes.mjs
// ============================================================

import { chromium } from 'playwright-extra'

const CDP_URL = 'http://localhost:9222'
const TARGET_HOST = '/web/geek/jobs'

// ---- Modality B+C：在页面上下文跑的提取脚本（字符串，交给 Runtime.evaluate）----
// 注意：这是发给 CDP Runtime.evaluate 的表达式，不能用 Node API。
const EXTRACT_EXPRESSION = `
(function () {
  const out = { globalHits: [], domCodes: [] };

  // ---- B. 全局 JS state 探测 ----
  const GLOBAL_CANDIDATES = ['__NUXT__', '__INITIAL_STATE__', '_PRELOADED_STATE_', '__PRELOADED_STATE__', 'INITIAL_DATA'];
  // 判断一个值是否像 {code,name} / {code,label} 选项数组
  function looksLikeCodeTable(v) {
    return Array.isArray(v) && v.length > 1 && v.every(
      (x) => x && typeof x === 'object' &&
        ('code' in x || 'value' in x || 'id' in x) &&
        ('name' in x || 'label' in x || 'text' in x)
    );
  }
  // 递归找 code table（限深度防爆栈/循环）
  function walk(obj, path, depth, seen) {
    if (depth > 6 || obj == null || typeof obj !== 'object') return;
    if (seen.has(obj)) return;
    seen.add(obj);
    for (const k of Object.keys(obj)) {
      let val;
      try { val = obj[k]; } catch { continue; }
      const p = path + '.' + k;
      if (looksLikeCodeTable(val)) {
        out.globalHits.push({
          path: p,
          sample: val.slice(0, 30).map((x) => ({
            code: x.code ?? x.value ?? x.id,
            name: x.name ?? x.label ?? x.text,
          })),
        });
      } else if (val && typeof val === 'object') {
        walk(val, p, depth + 1, seen);
      }
    }
  }
  for (const name of GLOBAL_CANDIDATES) {
    try {
      if (window[name]) walk(window[name], name, 0, new WeakSet());
    } catch (e) {}
  }

  // ---- C. DOM 扫描 ----
  const PARAM_RE = /(salary|experience|degree|jobType|position|scale|stage|industry)=([\\w,]+)/;
  const els = document.querySelectorAll('a, li, [data-val], [data-value], [data-code]');
  const seenDom = new Set();
  els.forEach((el) => {
    const text = (el.textContent || '').trim().slice(0, 24);
    if (!text) return;
    // C1: data-* 属性带 code
    const dataCode = el.getAttribute('data-val') || el.getAttribute('data-value') || el.getAttribute('data-code');
    if (dataCode) {
      const key = 'data|' + dataCode + '|' + text;
      if (!seenDom.has(key)) { seenDom.add(key); out.domCodes.push({ src: 'data-attr', code: dataCode, text }); }
    }
    // C2: href 带筛选参数
    const href = el.getAttribute && el.getAttribute('href');
    if (href) {
      const m = href.match(PARAM_RE);
      if (m) {
        const key = 'href|' + m[1] + '|' + m[2] + '|' + text;
        if (!seenDom.has(key)) { seenDom.add(key); out.domCodes.push({ src: 'href:' + m[1], code: m[2], text }); }
      }
    }
  });

  return JSON.stringify(out);
})()
`

async function main() {
  const browser = await chromium.connectOverCDP(CDP_URL)
  const context = browser.contexts()[0]
  if (!context) throw new Error('CDP context 不存在')

  const pages = context.pages()
  console.log(`📋 Chrome tabs: ${pages.length}`)
  pages.forEach((p, i) => console.log(`  [${i + 1}] ${(p.url() || '').slice(0, 90)}`))

  let searchPage = pages.find((p) => (p.url() || '').includes(TARGET_HOST))
  if (!searchPage) {
    searchPage = pages.find((p) => (p.url() || '').includes('zhipin.com'))
  }
  if (!searchPage) {
    console.log(`❌ 没找到 zhipin tab，请先在 Chrome 打开 ${TARGET_HOST}`)
    await browser.close()
    return
  }
  console.log(`\n✅ 目标页: ${searchPage.url()}\n`)

  const cdpSession = await context.newCDPSession(searchPage)
  await cdpSession.send('Network.enable')
  await cdpSession.send('Runtime.enable')

  // ---- A. Network：捕获 condition/filter/dict 类响应 ----
  const CONDITION_RE = /condition|filter|common\/data|zpCommon|dict|position\/|expect/i
  const conditionCalls = []
  const pending = new Map()
  cdpSession.on('Network.responseReceived', (params) => {
    const url = params.response.url
    if (url.includes('zhipin.com') && CONDITION_RE.test(url) && params.response.mimeType?.includes('json')) {
      pending.set(params.requestId, url)
    }
  })
  cdpSession.on('Network.loadingFinished', async (params) => {
    if (!pending.has(params.requestId)) return
    const url = pending.get(params.requestId)
    pending.delete(params.requestId)
    try {
      const { body, base64Encoded } = await cdpSession.send('Network.getResponseBody', { requestId: params.requestId })
      const text = base64Encoded ? Buffer.from(body, 'base64').toString('utf-8') : body
      try {
        const json = JSON.parse(text)
        conditionCalls.push({ url, zpDataKeys: json?.zpData ? Object.keys(json.zpData) : Object.keys(json), snippet: text.slice(0, 400) })
      } catch {
        conditionCalls.push({ url, raw: text.slice(0, 300) })
      }
    } catch (e) {
      conditionCalls.push({ url, error: e?.message?.slice(0, 100) })
    }
  })

  // 触发一次页面交互，让 BOSS 可能懒加载 condition 配置（reload 保证 condition API 重新发）
  console.log('🔄 reload 页面触发 condition 请求 + 等 6s...\n')
  await cdpSession.send('Page.enable').catch(() => {})
  await cdpSession.send('Page.reload').catch(() => {})
  await new Promise((r) => setTimeout(r, 6000))

  // ---- B+C：Runtime.evaluate 提取 DOM/全局码表 ----
  console.log('🔬 CDP Runtime.evaluate 提取全局 state + DOM 码表...\n')
  let extracted = { globalHits: [], domCodes: [] }
  try {
    const res = await cdpSession.send('Runtime.evaluate', {
      expression: EXTRACT_EXPRESSION,
      returnByValue: true,
      awaitPromise: false,
    })
    if (res?.result?.value) {
      extracted = JSON.parse(res.result.value)
    } else if (res?.exceptionDetails) {
      console.log('⚠️ Runtime.evaluate 异常:', JSON.stringify(res.exceptionDetails).slice(0, 200))
    }
  } catch (e) {
    console.log('⚠️ Runtime.evaluate 失败:', e?.message?.slice(0, 150))
  }

  // ---- 输出 ----
  console.log('============================================================')
  console.log('A. Network 捕获的 condition/filter 类响应')
  console.log('============================================================')
  if (conditionCalls.length === 0) {
    console.log('  (无 — BOSS 可能不通过独立 API 下发码表，看 B/C)\n')
  } else {
    conditionCalls.forEach((c, i) => {
      console.log(`[A${i + 1}] ${c.url}`)
      if (c.zpDataKeys) console.log(`  keys: ${c.zpDataKeys.join(', ')}`)
      if (c.snippet) console.log(`  snippet: ${c.snippet}`)
      if (c.raw) console.log(`  raw: ${c.raw}`)
      if (c.error) console.log(`  error: ${c.error}`)
      console.log()
    })
  }

  console.log('============================================================')
  console.log('B. 全局 JS state 里的 {code,name} 码表')
  console.log('============================================================')
  if (extracted.globalHits.length === 0) {
    console.log('  (无 — 全局态没暴露码表，看 C)\n')
  } else {
    extracted.globalHits.forEach((h) => {
      console.log(`\n📌 ${h.path}  (${h.sample.length} 项)`)
      h.sample.forEach((x) => console.log(`   ${String(x.code).padStart(8)} → ${x.name}`))
    })
    console.log()
  }

  console.log('============================================================')
  console.log('C. DOM 里带 code 的筛选元素')
  console.log('============================================================')
  if (extracted.domCodes.length === 0) {
    console.log('  (无 — 筛选下拉可能未展开/懒渲染。可手动在 Chrome 点开薪资/经验下拉后重跑)\n')
  } else {
    const bySrc = {}
    extracted.domCodes.forEach((d) => {
      ;(bySrc[d.src] ||= []).push(d)
    })
    for (const [src, arr] of Object.entries(bySrc)) {
      console.log(`\n📂 ${src}  (${arr.length} 项)`)
      arr.slice(0, 40).forEach((d) => console.log(`   ${String(d.code).padStart(10)} → ${d.text}`))
    }
    console.log()
  }

  await browser.close()
}

main().catch((err) => {
  console.error('❌ 码表探测失败:', err.message)
  process.exit(1)
})
