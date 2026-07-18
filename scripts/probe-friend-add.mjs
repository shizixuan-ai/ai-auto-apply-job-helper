#!/usr/bin/env node
// ============================================================
// BOSS friend/add.json 探针（Sprint 2026-07-14 — task #39）
// ============================================================
// 目的：验证 BOSS /wapi/zpgeek/friend/add.json 的真实请求协议。
//       对比 3 种风格（master 风格 / 我们当前风格 / master 完整风格）。
//       产出 tests/fixtures/friend-add-schema.json 作为契约测试黄金基准。
//
// 用法：
//   1. Chrome 已用 --remote-debugging-port=9222 启动 + BOSS 登录态有效
//   2. 【默认 safety】只跑 GET / OPTIONS + 解析 schema，不真发
//      npm run probe:friend-add 杭州
//   3. 【真发】显式 --really-send 仅 1 个 jobId（风控可控）
//      npm run probe:friend-add 杭州 -- --really-send
//   4. cat tests/fixtures/friend-add-schema.json 看每种尝试响应
//   5. 确认哪条路径有效后，调整 src/browser/index.ts sendGreeting
//   6. git add tests/fixtures/friend-add-schema.json 提交
//
// 关键纪律（按 ~\.claude/CLAUDE.md §3.8 + memory feedback_zero_tolerance_fake_green）：
//   - 不真发任何消息（默认 safety mode）
//   - 真发需显式 --really-send（避免误操作）
//   - 真发仅 1 个 jobId + 限定 1 次
//   - 探针结果直接落档（避免「凭印象写 ADR」）
//
// 来源：2026-07-14 send 真实调用一直失败，user 决策：
//   1. 借鉴 master 接口和参数
//   2. 先写 BOSS 探针脚本跱多接口（验证 master 协议真实有效）
//   3. 写 ADR-0007 记录证据溯源
// ============================================================

import 'dotenv/config'
import { connectToUserChrome, attachPlaywrightToCDP } from '../src/browser/cdp.js'

const city = process.argv[2] || '杭州'
const reallySend = process.argv.includes('--really-send')

console.log(`[probe-friend-add] 启动 CDP + 接管用户真 Chrome`)
console.log(`[probe-friend-add] city=${city}`)
console.log(`[probe-friend-add] safety mode: ${reallySend ? '⚠️  REALLY_SEND（仅 1 个 jobId）' : '✅ DRY_RUN（只 GET + OPTIONS，不真发）'}`)

if (reallySend) {
  console.log(`\n[probe-friend-add] ⚠️⚠️⚠️  你选择了 --really-send ⚠️⚠️⚠️`)
  console.log(`[probe-friend-add] 这次会真发 1 个 jobId（多次 POST 尝试同一 job）`)
  console.log(`[probe-friend-add] 请确认：`)
  console.log(`  1. 你已明白 BOSS 风控后果`)
  console.log(`  2. 你愿意接受失败 / 部分成功的现实`)
  console.log(`  3. 等待 5 秒后按 Ctrl+C 可中断\n`)
  await new Promise((r) => setTimeout(r, 5000))
}

const FRIEND_ADD_BASE = 'https://www.zhipin.com/wapi/zpgeek/friend/add.json'

// ============================================================
// 3 种参数风格对比（核心探针逻辑）
// ============================================================
const STYLES = [
  {
    id: 'P1-master-query-only',
    desc: 'master 风格：参数放 URL query，body=null',
    build: (job, zpToken) => {
      const url = `${FRIEND_ADD_BASE}?securityId=${encodeURIComponent(job.securityId)}&jobId=${encodeURIComponent(job.encryptJobId)}&lid=${encodeURIComponent(job.lid)}`
      return {
        url,
        fetchOpts: {
          method: 'POST',
          headers: { 'Zp_token': zpToken },
          body: null,
        },
      }
    },
  },
  {
    id: 'P2-ours-form-body',
    desc: '我们当前风格：form body gid/uid/message/expectInfo=0',
    build: (job, zpToken) => ({
      url: FRIEND_ADD_BASE,
      fetchOpts: {
        method: 'POST',
        headers: {
          'Zp_token': zpToken,
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        },
        body: `gid=${encodeURIComponent(job.encryptJobId)}&uid=${encodeURIComponent(job.encryptBossId)}&message=${encodeURIComponent('你好，我看了一下岗位挺合适的，可以了解一下吗？')}&expectInfo=0`,
      },
    }),
  },
  {
    id: 'P3-master-full',
    desc: 'master 完整：query + null body + Zp_token header + Cookie 冗余',
    build: (job, zpToken, cookieHeader) => {
      const url = `${FRIEND_ADD_BASE}?securityId=${encodeURIComponent(job.securityId)}&jobId=${encodeURIComponent(job.encryptJobId)}&lid=${encodeURIComponent(job.lid)}`
      return {
        url,
        fetchOpts: {
          method: 'POST',
          headers: {
            'Zp_token': zpToken,
            'Cookie': cookieHeader,
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
          },
          body: null,
        },
      }
    },
  },
]

// ============================================================
// 主流程
// ============================================================
try {
  const wrapper = await connectToUserChrome()
  const browser = await attachPlaywrightToCDP(wrapper)
  const context = browser.contexts()[0]
  if (!context) {
    throw new Error('CDP 接管成功但未找到 browser context（请确认 Chrome 已开窗口）')
  }

  const cookies = await context.cookies('https://www.zhipin.com')
  if (cookies.length === 0) {
    throw new Error('未找到 zhipin.com cookies — 请先在浏览器登录 BOSS')
  }
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ')

  // Zp_token = cookie "bst" 的值（按 master Tools.getCookieValue('bst')）
  const bstCookie = cookies.find((c) => c.name === 'bst')
  const zpToken = bstCookie?.value ?? ''

  console.log(`\n[probe-friend-add] 拿到 ${cookies.length} 个 BOSS cookies`)
  console.log(`[probe-friend-add] Zp_token (bst cookie): ${zpToken ? `${zpToken.slice(0, 8)}...${zpToken.slice(-4)}` : '❌ 未找到 bst cookie'}`)

  if (!zpToken) {
    throw new Error('未找到 bst cookie — friend/add 必需 Zp_token header')
  }

  // Step 1: 先拿 1 个真实 jobDetail（用现有 joblist.json 探针）
  console.log(`\n[probe-friend-add] Step 1: 调 joblist.json 拿 1 个真实 job...`)
  const joblistResp = await fetch('https://www.zhipin.com/wapi/zpgeek/search/joblist.json', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': cookieHeader,
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
    },
    body: JSON.stringify({
      query: '前端',
      scene: 1,
      page: 1,
      pageSize: 1,
      city: '101010100',
    }),
  })
  const joblistResult = await joblistResp.json()
  if (joblistResult.code !== 0 || !joblistResult.zpData?.jobList?.length) {
    throw new Error(`joblist.json 失败: code=${joblistResult.code} message=${joblistResult.message}`)
  }
  const sampleJob = joblistResult.zpData.jobList[0]
  console.log(`[probe-friend-add]   拿到 job: encryptJobId=${sampleJob.encryptJobId} lid=${sampleJob.lid}`)
  console.log(`[probe-friend-add]   encryptBossId=${sampleJob.encryptBossId?.slice(0, 8)}...`)
  console.log(`[probe-friend-add]   securityId length=${sampleJob.securityId?.length}`)

  // Step 2: 试 3 种风格
  console.log(`\n[probe-friend-add] Step 2: 探针 3 种风格${reallySend ? '（真发）' : '（safety mode — 默认不发）'}`)
  const results = []

  for (const style of STYLES) {
    console.log(`\n[probe-friend-add] ▶ 尝试 ${style.id}: ${style.desc}`)
    const { url, fetchOpts } = style.build(sampleJob, zpToken, cookieHeader)

    if (!reallySend) {
      // Safety mode：只解析 URL，不真发
      console.log(`[probe-friend-add]   URL: ${url}`)
      console.log(`[probe-friend-add]   Method: ${fetchOpts.method}`)
      console.log(`[probe-friend-add]   Headers: ${Object.keys(fetchOpts.headers || {}).join(', ')}`)
      console.log(`[probe-friend-add]   Body: ${fetchOpts.body === null ? 'null' : fetchOpts.body?.slice(0, 80) + '...'}`)
      console.log(`[probe-friend-add]   ⏸️  SAFETY MODE — 跳过实际 POST（加 --really-send 真发）`)
      results.push({
        styleId: style.id,
        mode: 'dry_run',
        url,
        method: fetchOpts.method,
        headers: fetchOpts.headers,
        body: fetchOpts.body,
        note: 'safety mode — 未真发',
      })
      continue
    }

    // Really send mode
    try {
      const resp = await fetch(url, fetchOpts)
      const status = resp.status
      const contentType = resp.headers.get('content-type') ?? ''
      let body
      if (contentType.includes('application/json')) {
        body = await resp.json()
      } else {
        body = { _text: (await resp.text()).slice(0, 500) }
      }

      const verdict = body?.code === 0
        ? '✅ SUCCESS'
        : `❌ REJECTED (code=${body?.code} msg=${body?.message?.slice(0, 60)})`
      console.log(`[probe-friend-add]   HTTP ${status} → ${verdict}`)
      console.log(`[probe-friend-add]   BOSS message: ${body?.message ?? '(none)'}`)
      if (body?.zpData?.bizData?.chatRemindDialog?.content) {
        console.log(`[probe-friend-add]   ⚠️ chatRemindDialog: ${body.zpData.bizData.chatRemindDialog.content}`)
      }

      results.push({
        styleId: style.id,
        mode: 'really_send',
        httpStatus: status,
        bossCode: body?.code,
        bossMessage: body?.message,
        chatRemindDialog: body?.zpData?.bizData?.chatRemindDialog?.content,
        raw: body,
      })
    } catch (err) {
      console.error(`[probe-friend-add]   ❌ fetch 失败: ${err.message}`)
      results.push({
        styleId: style.id,
        mode: 'really_send',
        error: err.message,
      })
    }
  }

  // Step 3: dump schema
  const { writeFileSync, mkdirSync } = await import('node:fs')
  const { dirname, resolve } = await import('node:path')
  const schemaPath = resolve(process.cwd(), 'tests/fixtures/friend-add-schema.json')
  mkdirSync(dirname(schemaPath), { recursive: true })

  const payload = {
    _meta: {
      capturedAt: new Date().toISOString(),
      source: 'BOSS /wapi/zpgeek/friend/add.json',
      method: 'context.cookies() + Node fetch (CDP 接管)',
      mode: reallySend ? 'really_send (1 jobId)' : 'dry_run (safety default)',
      city,
      sampleJobEncryptJobId: sampleJob.encryptJobId,
      sampleJobLid: sampleJob.lid,
      sampleJobBossIdPrefix: sampleJob.encryptBossId?.slice(0, 8),
      note: reallySend
        ? '⚠️ 真发探针，每个 style 都会真正调 1 次 friend/add'
        : '✅ safety 模式，只解析 URL + 不真发。run 加 --really-send 真发',
    },
    styles: results,
  }
  writeFileSync(schemaPath, JSON.stringify(payload, null, 2))

  console.log(`\n[probe-friend-add] ✅ schema dumped to ${schemaPath}`)
  console.log(`[probe-friend-add] 👉 下一步:`)
  if (reallySend) {
    console.log(`   cat ${schemaPath} | jq '.styles[] | {styleId, httpStatus, bossCode, bossMessage}'`)
    console.log(`   找到 bossCode=0 的 style → 调整 src/browser/index.ts sendGreeting`)
  } else {
    console.log(`   当前是 safety mode（未真发）`)
    console.log(`   决策：是否要真发？若要 → npm run probe:friend-add 杭州 -- --really-send`)
  }

  await browser.close().catch(() => {})
} catch (err) {
  console.error(`\n[probe-friend-add] ❌ 失败: ${err.message}`)
  console.error(`\n排查步骤:`)
  console.error(`  1. Chrome 是否已用 --remote-debugging-port=9222 启动？`)
  console.error(`  2. BOSS 登录态是否有效（需要先 bapply login）？`)
  console.error(`  3. 端口 9222 是否被占用？lsof -i :9222`)
  console.error(`  4. 是否在 BOSS 域有 bst cookie？`)
  process.exit(1)
}