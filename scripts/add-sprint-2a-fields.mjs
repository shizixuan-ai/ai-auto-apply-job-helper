// 一次性脚本：给飞书表加 3 个字段（Sprint 2A — sendGreeting friend/add 配套）
//   1. HR_UID       — 文本（BOSS HR 加密 uid，friend/add 第二参数）
//   2. 打招呼状态    — 单选（5 个状态，与 src/types GreetStatus 严格对齐）
//   3. 打招呼时间    — 日期（毫秒时间戳，与 Sprint 1A 匹配时间同 pattern）
//
// 参考：
//   - scripts/add-sprint-1a-fields.mjs（模式：列已有字段 → 幂等添加）
//   - Sprint 1A commit 8271315：飞书日期字段 type=5 要 ms 时间戳（不能用 ISO）
//
// 用法：npx tsx scripts/add-sprint-2a-fields.mjs

import 'dotenv/config'

const appToken = process.env.FEISHU_APP_TOKEN
const tableId = process.env.FEISHU_TABLE_ID
const appId = process.env.FEISHU_APP_ID
const appSecret = process.env.FEISHU_APP_SECRET

// P0 guard (hook REQUIRES_FIX 2026-07-09): 4 个 env 缺任一就 exit 1
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

// 3. 准备要加的字段
//   飞书类型：1=文本, 2=数字, 3=单选, 5=日期
//   单选必须带 property.options
//   单选 label 与 GreetStatus 严格对齐（src/types/index.ts）
const fieldsToAdd = [
  {
    name: 'HR_UID',
    type: 1,
    description: 'BOSS HR 加密 uid（friend/add 第二参数 uid）',
    property: null,
  },
  {
    name: '打招呼状态',
    type: 3,
    description: 'Sprint 2A 5 状态枚举（与 src/types GreetStatus 严格对齐）',
    property: {
      options: [
        { name: '待发送', color: 0 },
        { name: '已发送', color: 1 },
        { name: '失败', color: 2 },
        { name: '触发限额', color: 3 },
        { name: '风控拦截', color: 4 },
      ],
    },
  },
  {
    name: '打招呼时间',
    type: 5,
    description: 'handler 写回时间（毫秒时间戳，与匹配时间同 pattern）',
    property: null,
  },
]

// 4. 逐个加
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

console.log('\n完成！请跑 scripts/verify-feishu.mjs 验证字段已加。')