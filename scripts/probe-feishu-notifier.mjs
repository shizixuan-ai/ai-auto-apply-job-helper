#!/usr/bin/env node
// ================================================================
// scripts/probe-feishu-notifier.mjs — PROTOTYPE (一次性, E-1 落地前)
//
// 目标: 验证 feishu-notifier 7 个核心假设 (E-1 GREEN 前).
//
// 验证范围:
//   A1: 基础 POST — 200 + body {code:0} → success, 1 次 call
//   A2: 5xx retry success — 1 次 500, 2 次 200+{code:0} → success, 2 次 call
//   A3: 5xx all fail — 3 次都 500 → warnLogger 1 次, 不抛, sleep 2 次 (1s+2s)
//   A4: backoff timing — sleep 调用 [1000, 2000] (初 1000ms, 2^1=2000)
//   A5: 4xx no retry — 1 次 400 → 不重试, warnLogger 1 次, 不抛, sleep 0 次
//   A6 [架构师 review 必修正]: HTTP 200 + body code !== 0 → 不重试, warnLogger 1 次,
//       不抛 (e.g. code=19001 invalid webhook URL)
//   A7 [架构师 review 强烈建议]: msg 长度 > 19000 → 截断到 19000 + '...(truncated)' 后缀
//
// 单账号红线: 0 触碰 BOSS (feishu webhook 不是 BOSS, 测试用 mock HTTP server)
//
// 运行: node scripts/probe-feishu-notifier.mjs
// 输出: 7 行 [PASS/FAIL] + 总摘要
// 后续: 验证完 → 删除 或 留作 ADR §17.13 证据 (per ADR §9 第 1 项)
// ================================================================

import * as http from 'node:http'

// ─── 候选 FeishuNotifier 实现 (供 probe 验证用) ───────────────

function formatFeishuText(level, msg) {
  // 架构师 review 建议 A7: msg 截断 19000 字符 + 后缀
  const MAX_LEN = 19000
  let text = msg
  if (msg.length > MAX_LEN) {
    text = msg.slice(0, MAX_LEN) + '...(truncated)'
  }
  const tag = level === 'critical' ? '🔴 [CRITICAL]' : '🟡 [WARN]'
  return `${tag} ${text}`
}

function createFeishuNotifier(opts) {
  const {
    webhookUrl,
    maxRetries = 3,
    initialBackoffMs = 1000,
    timeoutMs = 5000,
    fetchImpl = globalThis.fetch.bind(globalThis),
    sleepImpl = (ms) => new Promise((r) => setTimeout(r, ms)),
    warnLogger = (m) => console.warn(`[FEISHU] ${m}`),
  } = opts

  async function notify(level, msg) {
    const text = formatFeishuText(level, msg)
    const body = JSON.stringify({
      msg_type: 'text',
      content: { text },
    })

    let lastError
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const ctrl = new AbortController()
      const tid = setTimeout(() => ctrl.abort(), timeoutMs)
      try {
        const resp = await fetchImpl(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          signal: ctrl.signal,
        })
        clearTimeout(tid)
        if (resp.ok) {
          // [架构师 review 必修正 A6] 检查 body code, 不只信 HTTP 200
          const json = await resp.json()
          if (json.code === 0) {
            return  // 业务成功
          }
          // 业务失败 — 不重试 (URL/格式无效, 重试无效)
          lastError = new Error(`feishu business error: code=${json.code} msg=${json.msg}`)
          break
        }
        // 4xx 不重试 (per 架构师 review: 客户端错误不应重发)
        if (resp.status >= 400 && resp.status < 500) {
          lastError = new Error(`HTTP ${resp.status} (no retry)`)
          break
        }
        lastError = new Error(`HTTP ${resp.status}`)  // 5xx: 继续重试
      } catch (e) {
        clearTimeout(tid)
        lastError = e
      }
      if (attempt < maxRetries - 1) {
        await sleepImpl(initialBackoffMs * 2 ** attempt)
      }
    }
    warnLogger(
      `${maxRetries}/${maxRetries} attempts failed: ${lastError?.message ?? 'unknown'}`,
    )
    // 不抛 — §3.9 不变量
  }

  return { notify }
}

// ─── Mock webhook server ───────────────────────────────────────

function startMockServer(handler) {
  return new Promise((resolve) => {
    let callCount = 0
    const server = http.createServer(async (req, res) => {
      callCount++
      await handler(req, res, callCount)
    })
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        url: `http://127.0.0.1:${port}/webhook`,
        stop: () => new Promise((r) => server.close(r)),
        getCalls: () => callCount,
      })
    })
  })
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (c) => (data += c))
    req.on('end', () => resolve(data))
  })
}

// ─── Probe 验证 ──────────────────────────────────────────────────

const results = []
function record(id, ok, msg) {
  results.push({ id, ok, msg })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${id} ${msg}`)
}

async function runA1() {
  const sleeps = []
  const warns = []
  const server = await startMockServer(async (req, res) => {
    await readBody(req)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ code: 0, msg: 'success' }))
  })
  const notifier = createFeishuNotifier({
    webhookUrl: server.url,
    sleepImpl: (ms) => { sleeps.push(ms); return Promise.resolve() },
    warnLogger: (m) => warns.push(m),
  })
  await notifier.notify('critical', '[AUTO.guard] 风控触发')
  server.stop()
  const calls = server.getCalls()
  const ok = calls === 1 && sleeps.length === 0 && warns.length === 0
  record('A1', ok, `200+code:0 → 1 call, 0 sleep, 0 warn (got calls=${calls} sleep=${sleeps.length} warn=${warns.length})`)
}

async function runA2() {
  const sleeps = []
  const warns = []
  let n = 0
  const server = await startMockServer(async (req, res) => {
    await readBody(req)
    n++
    if (n === 1) {
      res.writeHead(500); res.end()
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ code: 0, msg: 'success' }))
    }
  })
  const notifier = createFeishuNotifier({
    webhookUrl: server.url,
    sleepImpl: (ms) => { sleeps.push(ms); return Promise.resolve() },
    warnLogger: (m) => warns.push(m),
  })
  await notifier.notify('critical', 'retry test')
  server.stop()
  const calls = server.getCalls()
  // 5xx 是 lastError → 重试;成功在 2nd → 退出;仅 1 次 sleep (after 1st attempt)
  const ok = calls === 2 && sleeps.length === 1 && sleeps[0] === 1000 && warns.length === 0
  record('A2', ok, `500→200+code:0 → 2 calls, 1 sleep=1000 (got calls=${calls} sleeps=${JSON.stringify(sleeps)})`)
}

async function runA3() {
  const sleeps = []
  const warns = []
  const server = await startMockServer(async (req, res) => {
    await readBody(req)
    res.writeHead(503); res.end()
  })
  const notifier = createFeishuNotifier({
    webhookUrl: server.url,
    sleepImpl: (ms) => { sleeps.push(ms); return Promise.resolve() },
    warnLogger: (m) => warns.push(m),
  })
  await notifier.notify('critical', 'all fail')
  server.stop()
  const calls = server.getCalls()
  // 3 attempts, 2 sleeps between (1000, 2000), 1 warn
  const ok =
    calls === 3
    && sleeps.length === 2
    && sleeps[0] === 1000 && sleeps[1] === 2000
    && warns.length === 1
  record('A3', ok, `3×503 → 3 calls, 2 sleeps=[1000,2000], 1 warn (got calls=${calls} sleeps=${JSON.stringify(sleeps)} warn=${warns.length})`)
}

async function runA4() {
  // A3 已验证 backoff timing;此处显式验证指数 base × 2^attempt
  const sleeps = []
  const server = await startMockServer(async (req, res) => {
    await readBody(req); res.writeHead(500); res.end()
  })
  const notifier = createFeishuNotifier({
    webhookUrl: server.url,
    initialBackoffMs: 100,
    sleepImpl: (ms) => { sleeps.push(ms); return Promise.resolve() },
  })
  await notifier.notify('warn', 'timing')
  server.stop()
  const ok = sleeps[0] === 100 && sleeps[1] === 200  // 100 × 2^0=100, 100 × 2^1=200
  record('A4', ok, `backoff = initial × 2^attempt (got ${JSON.stringify(sleeps)})`)
}

async function runA5() {
  const sleeps = []
  const warns = []
  const server = await startMockServer(async (req, res) => {
    await readBody(req)
    res.writeHead(400); res.end('Bad Request')
  })
  const notifier = createFeishuNotifier({
    webhookUrl: server.url,
    sleepImpl: (ms) => { sleeps.push(ms); return Promise.resolve() },
    warnLogger: (m) => warns.push(m),
  })
  await notifier.notify('warn', 'client error')
  server.stop()
  const calls = server.getCalls()
  // 4xx 不重试, 立即 warn
  const ok = calls === 1 && sleeps.length === 0 && warns.length === 1
  record('A5', ok, `400 → 1 call, 0 sleep (no retry), 1 warn (got calls=${calls} sleeps=${sleeps.length} warn=${warns.length})`)
}

async function runA6() {
  // [架构师 review 必修正] 飞书 webhook 总是返 200, business fail 在 body code
  const sleeps = []
  const warns = []
  const server = await startMockServer(async (req, res) => {
    await readBody(req)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ code: 19001, msg: 'invalid webhook url' }))
  })
  const notifier = createFeishuNotifier({
    webhookUrl: server.url,
    sleepImpl: (ms) => { sleeps.push(ms); return Promise.resolve() },
    warnLogger: (m) => warns.push(m),
  })
  await notifier.notify('critical', 'business fail')
  server.stop()
  const calls = server.getCalls()
  // 200 + code!=0 → 不重试, 1 warn
  const ok = calls === 1 && sleeps.length === 0 && warns.length === 1 && warns[0].includes('19001')
  record('A6', ok, `200+code:19001 → 1 call, 0 sleep (no retry), 1 warn containing 19001 (got calls=${calls} warn=${JSON.stringify(warns)})`)
}

async function runA7() {
  // [架构师 review 强烈建议] msg 长度截断
  const longMsg = 'x'.repeat(25000)
  const received = []
  const server = await startMockServer(async (req, res) => {
    const body = await readBody(req)
    received.push(JSON.parse(body))
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ code: 0, msg: 'success' }))
  })
  const notifier = createFeishuNotifier({ webhookUrl: server.url })
  await notifier.notify('warn', longMsg)
  server.stop()
  const text = received[0]?.content?.text ?? ''
  const hasTruncation = text.includes('...(truncated)')
  // 完整 text 应包含 tag prefix + 19000 x + 后缀 = ~19018 chars
  const ok = hasTruncation && text.length <= 19200
  record('A7', ok, `25000-char msg → truncated to 19000+'...(truncated)' (got len=${text.length}, hasMarker=${hasTruncation})`)
}

async function main() {
  console.log('=== feishu-notifier probe (E-1 前置, 7 scenarios) ===\n')
  await runA1()
  await runA2()
  await runA3()
  await runA4()
  await runA5()
  await runA6()
  await runA7()
  const passed = results.filter((r) => r.ok).length
  console.log(`\n=== Total: ${passed}/${results.length} PASS ===`)
  process.exit(passed === results.length ? 0 : 1)
}

main().catch((e) => {
  console.error('probe crash:', e)
  process.exit(2)
})
