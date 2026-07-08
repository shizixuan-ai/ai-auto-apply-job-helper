// 一次性脚本：给飞书表加 4 个字段（分数/匹配原因/JD摘要/匹配时间）
// 参考 scripts/init-feishu.sh:138 的字段定义模式
// 用法：npx tsx scripts/add-sprint-1a-fields.mjs

import 'dotenv/config'

const appToken = process.env.FEISHU_APP_TOKEN
const tableId = process.env.FEISHU_TABLE_ID
console.log(`appToken=${appToken} tableId=${tableId}\n`)

// 1. 先拿 tenant token
const tokenResp = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    app_id: process.env.FEISHU_APP_ID,
    app_secret: process.env.FEISHU_APP_SECRET,
  }),
})
const { tenant_access_token, code, msg } = await tokenResp.json()
if (code !== 0) {
  console.error('❌ 拿 token 失败:', msg)
  process.exit(1)
}
console.log('✓ 拿到 tenant_access_token\n')

// 2. 列出已有字段
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
// 类型参考：https://open.feishu.cn/document/server-docs/docs/bitable-v1/app-table-field/guide
//   1=文本, 2=数字, 3=单选, 5=日期, 7=复选框, 11=人员, 13=电话号码, 15=URL, 17=附件, 18=单向关联, 20=公式, 21=双向关联, 22=地理位置, 23=群组
const fieldsToAdd = [
  { name: '分数', type: 2, description: 'LLM 评分（0~1）' },
  { name: '匹配原因', type: 1, description: 'LLM 给的匹配/不匹配原因' },
  { name: 'JD摘要', type: 1, description: 'JD 前 200 字' },
  { name: '匹配时间', type: 5, description: 'handler 写入时间（ISO 8601）' },
]

// 4. 逐个加
for (const f of fieldsToAdd) {
  if (existing.has(f.name)) {
    console.log(`⏭  字段已存在: ${f.name}，跳过`)
    continue
  }
  const body = { field_name: f.name, type: f.type }
  // 数字类型需要 property: { formatter: '0.00' } 才能正确显示小数
  if (f.type === 2) {
    body.property = { formatter: '0.00' }
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

console.log('\n完成！')
