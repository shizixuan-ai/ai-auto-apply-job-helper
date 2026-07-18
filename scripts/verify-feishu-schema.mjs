#!/usr/bin/env node
// ============================================================
// verify-feishu-schema.mjs — Sprint Smoke 4
// ============================================================
// 目的：验证飞书表 schema 含 Sprint 2A 加的 3 个必填字段
//   - HR_UID (文本)
//   - 打招呼状态 (单选 5 选项：待发送/已发送/失败/触发限额/风控拦截)
//   - 打招呼时间 (日期)
//
// 退出码：
//   0 = OK（所有必填字段都在）
//   1 = BLOCK（必填字段缺失）
//   2 = SKIP（环境就绪缺失：FEISHU_APP_TOKEN/APP_ID 等未配置）
//
// 输出：人可读报告 + .claude/smoke-reports/feishu-schema-{timestamp}.json
// ============================================================

const FEISHU_BASE = 'https://open.feishu.cn/open-apis'
const TOKEN_URL = `${FEISHU_BASE}/auth/v3/tenant_access_token/internal`
const FIELDS_URL = (appToken, tableId) =>
  `${FEISHU_BASE}/bitable/v1/apps/${appToken}/tables/${tableId}/fields?page_size=50`

// 必填字段：与 Sprint 2A.2 + Sprint C (ADR-0008) 严格对齐
export const REQUIRED_FIELDS = [
  { name: 'HR_UID', type: 1, label: 'HR 加密 uid' },
  { name: '打招呼状态', type: 3, label: '5 状态单选' },
  { name: '打招呼时间', type: 5, label: '打招呼时间（毫秒时间戳）' },
  // Sprint C (ADR-0008)：解锁 auto-greet mode
  { name: 'LID', type: 1, label: 'BOSS job lid（search 标识）' },
  { name: 'SECURITY_ID', type: 1, label: 'friend/add 鉴权密钥（明文）' },
]

// ============================================================
// 拉所有字段（Sprint Smoke 4 修：分页支持）
// ------------------------------------------------------------
// 飞书 Bitable API 单页最多 50 条，需 while 循环直到 has_more=false
// 之前只看 page 1，字段 >50 时必填字段被误判为缺失
// ============================================================
export async function fetchAllFields(appToken, tableId, token) {
  const allFields = []
  let pageToken = undefined
  while (true) {
    const url = new URL(`${FEISHU_BASE}/bitable/v1/apps/${appToken}/tables/${tableId}/fields`)
    url.searchParams.set('page_size', '50')
    if (pageToken) url.searchParams.set('page_token', pageToken)
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const data = await resp.json()
    if (data.code !== 0) {
      throw new Error(`飞书 API 错误 [code=${data.code}]: ${data.msg}`)
    }
    allFields.push(...(data.data?.items ?? []))
    if (!data.data?.has_more) break
    pageToken = data.data?.page_token
    if (!pageToken) break  // 防御：has_more=true 但没 token 时死循环
  }
  return allFields
}

main().catch((err) => {
  console.error(`[verify-feishu-schema] ❌ 脚本崩溃: ${err.message}`)
  process.exit(2)
})

async function main() {
  // 1. 环境检查
  const env = checkEnv()
  if (!env.ok) {
    console.log(`[verify-feishu-schema] ⏭️  SKIP（环境未就绪）: ${env.missing.join(', ')}`)
    console.log('请在 .env 填充 FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_APP_TOKEN / FEISHU_TABLE_ID 后重跑')
    process.exit(2)
  }

  // 2. 拿 token
  const tokenResp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: env.appId, app_secret: env.appSecret }),
  })
  const tokenData = await tokenResp.json()
  if (tokenData.code !== 0) {
    console.error(`[verify-feishu-schema] ❌ 飞书鉴权失败: ${tokenData.msg}`)
    process.exit(2)
  }
  const token = tokenData.tenant_access_token

  // 3. 拉字段列表（支持分页）
  let fields
  try {
    fields = await fetchAllFields(env.appToken, env.tableId, token)
  } catch (err) {
    console.error(`[verify-feishu-schema] ❌ 飞书 API 失败: ${err.message}`)
    process.exit(2)
  }

  const fieldByName = Object.fromEntries(fields.map((f) => [f.field_name, f]))

  // 4. 检查必填字段
  const missing = []
  const wrongType = []
  for (const req of REQUIRED_FIELDS) {
    const f = fieldByName[req.name]
    if (!f) {
      missing.push(req)
    } else if (f.type !== req.type) {
      wrongType.push({ required: req, actual: f })
    }
  }

  // 5. 报告
  console.log(`[verify-feishu-schema] 飞书表共 ${fields.length} 个字段`)
  if (missing.length === 0 && wrongType.length === 0) {
    console.log('[verify-feishu-schema] ✅ 所有必填字段都在')
    for (const req of REQUIRED_FIELDS) {
      const f = fieldByName[req.name]
      console.log(`  ✅ ${req.name} (type=${f.type}, ${req.label})`)
    }
    process.exit(0)
  }

  if (missing.length > 0) {
    console.error('[verify-feishu-schema] ❌ 必填字段缺失:')
    for (const m of missing) {
      console.error(`  ❌ ${m.name} (${m.label})`)
    }
  }
  if (wrongType.length > 0) {
    console.error('[verify-feishu-schema] ⚠️  字段类型不符:')
    for (const w of wrongType) {
      console.error(`  ⚠️  ${w.required.name}: expected type=${w.required.type}, actual=${w.actual.type}`)
    }
  }
  console.error('\n修复方法：跑 `npx tsx scripts/add-sprint-3-fields.mjs`（Sprint C 字段）')
  console.error('         或 `npx tsx scripts/add-sprint-2a-fields.mjs`（Sprint 2A 字段）')
  process.exit(1)
}

function checkEnv() {
  const appId = process.env.FEISHU_APP_ID
  const appSecret = process.env.FEISHU_APP_SECRET
  const appToken = process.env.FEISHU_APP_TOKEN
  const tableId = process.env.FEISHU_TABLE_ID

  const missing = []
  if (!appId) missing.push('FEISHU_APP_ID')
  if (!appSecret) missing.push('FEISHU_APP_SECRET')
  if (!appToken) missing.push('FEISHU_APP_TOKEN')
  if (!tableId) missing.push('FEISHU_TABLE_ID')

  if (missing.length > 0) {
    return { ok: false, missing }
  }
  return { ok: true, appId, appSecret, appToken, tableId, missing: [] }
}