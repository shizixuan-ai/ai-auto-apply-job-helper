// ============================================================
// 一次性脚本：给飞书表加 2 个字段（Sprint C — 解锁 auto-greet）
//   1. LID         — 文本（type=1）来自 BOSS joblist.json.lid
//                    用途：friend/add URL query 参数
//   2. SECURITY_ID — 文本（type=1，无长度硬限制）来自 BOSS joblist.json.securityId
//                    用途：friend/add URL query 参数 + 鉴权
//                    ⚠️ 含 BOSS 反爬密钥，明文存（飞书 Bitable 1.0 不支持字段加密）
// ============================================================
// 参考：
//   - scripts/add-sprint-2a-fields.mjs（幂等模式：列已有字段 → 跳过已存在 → 添加）
//   - ADR-0008（2026-07-18）：schema 升级决策（LID/SECURITY_ID 同时建）
//
// 用法：npx tsx scripts/add-sprint-3-fields.mjs
//
// 前置：跑前请确认 .env 已配置：
//   FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_APP_TOKEN / FEISHU_TABLE_ID
// ============================================================

import 'dotenv/config'

const appToken = process.env.FEISHU_APP_TOKEN
const tableId = process.env.FEISHU_TABLE_ID
const appId = process.env.FEISHU_APP_ID
const appSecret = process.env.FEISHU_APP_SECRET

// P0 guard（参考 add-sprint-2a-fields.mjs:19）：4 个 env 缺任一就 exit 1
//   - 防止发到 undefined 的 URL
//   - 防止 token 请求 body 缺 app_id/app_secret 导致飞书返 unknown error
if (!appToken || !tableId || !appId || !appSecret) {
  console.error('❌ 缺少必要的飞书环境变量:')
  if (!appId) console.error('   - FEISHU_APP_ID')
  if (!appSecret) console.error('   - FEISHU_APP_SECRET')
  if (!appToken) console.error('   - FEISHU_APP_TOKEN')
  if (!tableId) console.error('   - FEISHU_TABLE_ID')
  console.error('   请配置 .env 后再跑本脚本')
  process.exit(1)
}
console.log(`appToken=${appToken} tableId=${tableId}\n`)

// 1. 拿 tenant token
const tokenResp = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    app_id: process.env.FEISHU_APP_ID,
    app_secret: process.env.FEISHU_APP_SECRET,
  }),
})
const { tenant_access_token, code: tokCode, msg: tokMsg } = await tokenResp.json()
if (tokCode !== 0) {
  console.error('❌ 拿 token 失败:', tokMsg)
  process.exit(1)
}
console.log('✓ 拿到 tenant_access_token\n')

// 2. 列已有字段
const listResp = await fetch(
  `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/fields`,
  { headers: { Authorization: `Bearer ${tenant_access_token}` } },
)
const listData = await listResp.json()
if (listData.code !== 0) {
  console.error('❌ 列字段失败:', listData.msg)
  process.exit(1)
}
const existing = new Set(listData.data.items.map((f) => f.field_name))
console.log('✓ 已有字段:', Array.from(existing).join(', '), '\n')

// 3. 准备要加的字段（Sprint C — ADR-0008）
//   飞书类型：1=文本（无长度硬限制，支持长字符串如 200+ 字符 securityId）
//   注意：10001/10002 是系统字段（创建/修改时间），不是"多行文本"
//   详见 ADR-0008 §7.3 关系图修正备注
const fieldsToAdd = [
  {
    name: 'LID',
    type: 1,
    description: 'BOSS job lid（来自 search joblist.json，friend/add URL query 参数）',
    property: null,
  },
  {
    name: 'SECURITY_ID',
    type: 1,
    description: 'BOSS friend/add 鉴权密钥（来自 search joblist.json.securityId，明文存）',
    property: null,
  },
]

// 4. 逐个加（幂等：已存在则跳过）
for (const f of fieldsToAdd) {
  if (existing.has(f.name)) {
    console.log(`⏭  字段已存在: ${f.name}，跳过`)
    continue
  }
  const body = { field_name: f.name, type: f.type }
  if (f.property) {
    body.property = f.property
  }

  const createResp = await fetch(
    `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/fields`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tenant_access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
  )
  const createData = await createResp.json()
  if (createData.code !== 0) {
    console.error(`❌ 创建 ${f.name} 失败:`, createData.msg)
  } else {
    console.log(`✓ 字段创建成功: ${f.name} (type=${f.type})`)
  }
}

console.log('\n完成！请跑 scripts/verify-feishu-schema.mjs 验证字段已加。')