#!/usr/bin/env node
// ============================================================
// BOSS API 探针（Sprint 2B Step A — 补充 6）
// ============================================================
// 目的：真跑一次 BOSS search API，dump 第一条 job 的 schema 到 tests/fixtures/boss-schema.json
//       作为契约测试的"黄金基准"
//
// 用法：
//   1. Chrome 已用 --remote-debugging-port=9222 启动 + BOSS 登录态有效
//   2. npm run probe:boss 前端 杭州
//   3. cat tests/fixtures/boss-schema.json 看 userRelatedFields
//   4. 确认 HR 加密 uid 字段名（推断为 encryptUserId）
//   5. 若字段名不同，调整 src/browser/index.ts extractHrUid() 的 fallback chain
//   6. git add tests/fixtures/boss-schema.json 提交
//
// 关键修法（Sprint 2B Step A 实施时踩坑三次）：
//   v1: createCDPSession + searchJobs → BOSS SPA navigation 打断 page.goto
//   v2: context.newPage() + page.evaluate → 仍被 BOSS 客户端路由打断
//   v3: context.cookies() + Node fetch → ✅ 稳（无 page 操作，无 navigation 干扰）
// ============================================================

import 'dotenv/config'
import { connectToUserChrome, attachPlaywrightToCDP } from '../src/browser/cdp.js'

const keyword = process.argv[2] || '前端'
const city = process.argv[3] || undefined

console.log(`[probe] 启动 CDP + 接管用户真 Chrome`)
console.log(`[probe] 准备调 BOSS /wapi/zpgeek/search/joblist.json (keyword="${keyword}" city=${city ?? 'undefined'})`)
console.log(`[probe] 用 context.cookies() + Node fetch 绕过 page navigation 干扰`)

try {
  const wrapper = await connectToUserChrome()
  const browser = await attachPlaywrightToCDP(wrapper)
  const context = browser.contexts()[0]
  if (!context) {
    throw new Error('CDP 接管成功但未找到 browser context（请确认 Chrome 已开窗口）')
  }

  // 拿 BOSS 域 cookies（不需要 page，跳过所有 navigation 风险）
  const cookies = await context.cookies('https://www.zhipin.com')
  if (cookies.length === 0) {
    throw new Error('未找到 zhipin.com cookies — 请先在浏览器登录 BOSS')
  }
  const cookieHeader = cookies
    .filter((c) => !c.httpOnly || c.name === 'zp_token') // 保留所有 cookie，page.evaluate 时 browser 自动处理
    .map((c) => `${c.name}=${c.value}`)
    .join('; ')

  console.log(`[probe] 拿到 ${cookies.length} 个 BOSS cookies`)

  // 城市编码
  const CITY_CODES = {
    '北京': '101010100', '上海': '101020100', '广州': '101280100',
    '深圳': '101280600', '杭州': '101210100', '成都': '101270100',
    '南京': '101190100', '武汉': '101200100', '西安': '101110100',
    '苏州': '101190400', '厦门': '101300100', '长沙': '101250100',
  }
  const apiBody = {
    query: keyword,
    scene: 1,
    page: 1,
    pageSize: 20,
  }
  if (city && CITY_CODES[city]) {
    apiBody.city = CITY_CODES[city]
  }

  // Node.js fetch — 无 page，无 navigation 干扰
  const resp = await fetch('https://www.zhipin.com/wapi/zpgeek/search/joblist.json', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': cookieHeader,
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
    },
    body: JSON.stringify(apiBody),
  })
  const apiResult = await resp.json()

  if (apiResult.code !== 0 || !apiResult.zpData?.jobList?.length) {
    console.error(`[probe] ❌ API 响应异常: code=${apiResult.code} message=${apiResult.message}`)
    console.error(`[probe] 完整响应: ${JSON.stringify(apiResult).slice(0, 500)}`)
    process.exit(1)
  }

  const firstJob = apiResult.zpData.jobList[0]
  console.log(`\n[probe] ✅ 成功获取 ${apiResult.zpData.jobList.length} 个 job`)
  console.log(`[probe] sample job:`)
  console.log(`  encryptJobId: ${firstJob.encryptJobId}`)
  console.log(`  jobName: ${firstJob.jobName}`)
  console.log(`  brandName: ${firstJob.brandName}`)
  console.log(`  salaryDesc: ${firstJob.salaryDesc}`)

  // 脱敏 dump schema
  const { writeFileSync, mkdirSync } = await import('node:fs')
  const { dirname, resolve } = await import('node:path')
  const schemaPath = resolve(process.cwd(), 'tests/fixtures/boss-schema.json')
  mkdirSync(dirname(schemaPath), { recursive: true })

  const sanitize = (key, value) => {
    if (typeof value !== 'string') return value
    if (/name|brand|company|title|jobName|brandName|salaryDesc|avatar|district|business/i.test(key)) {
      return value.length > 12 ? value.slice(0, 8) + '...' : value
    }
    if (/url|link/i.test(key)) return '[URL_OMITTED]'
    return value
  }
  // gps 坐标是 PII，固定 anonymize（不依赖 sanitize 函数）
  if (sanitized.gps && typeof sanitized.gps === 'object') {
    sanitized.gps = { longitude: '[REDACTED]', latitude: '[REDACTED]' }
  }
  const sanitized = {}
  for (const [k, v] of Object.entries(firstJob)) {
    sanitized[k] = sanitize(k, v)
  }
  const userRelated = Object.keys(firstJob)
    .filter((k) => /user|hr|encrypt/i.test(k))
    .map((k) => ({ key: k, value: firstJob[k] }))

  const payload = {
    _meta: {
      capturedAt: new Date().toISOString(),
      source: 'BOSS /wapi/zpgeek/search/joblist.json',
      method: 'context.cookies() + Node fetch (绕过 page navigation 干扰)',
      keyword,
      city: city ?? null,
      jobListIndex: 0,
      jobListTotal: apiResult.zpData.jobList.length,
      note: '契约测试的"黄金基准"。BOSS 改版时重新跑 npm run probe:boss 覆盖。',
    },
    sampleJob: sanitized,
    userRelatedFields: userRelated,
  }
  writeFileSync(schemaPath, JSON.stringify(payload, null, 2))

  console.log(`\n[probe] ✅ schema dumped to ${schemaPath}`)
  console.log(`[probe] 关键 user 相关字段 (${userRelated.length} 个):`)
  for (const { key, value } of userRelated) {
    console.log(`  ${key}: ${value}`)
  }
  console.log(`\n[probe] 👉 下一步:`)
  console.log(`   cat tests/fixtures/boss-schema.json | jq .userRelatedFields`)
  console.log(`   确认 encryptUserId 字段存在则 OK，否则调整 extractHrUid() fallback chain`)

  await browser.close().catch(() => {})
} catch (err) {
  console.error(`\n[probe] ❌ 失败: ${err.message}`)
  console.error(`\n排查步骤:`)
  console.error(`  1. Chrome 是否已用 --remote-debugging-port=9222 启动？`)
  console.error(`  2. BOSS 登录态是否有效（需要先 bapply login）？`)
  console.error(`  3. 端口 9222 是否被占用？lsof -i :9222`)
  process.exit(1)
}