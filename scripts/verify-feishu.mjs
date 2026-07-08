// 验证飞书表里有多少条记录（直接调 lark API，不走 listRecords）
import 'dotenv/config'

const appToken = process.env.FEISHU_APP_TOKEN
const tableId = process.env.FEISHU_TABLE_ID

const tokenResp = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    app_id: process.env.FEISHU_APP_ID,
    app_secret: process.env.FEISHU_APP_SECRET,
  }),
})
const { tenant_access_token } = await tokenResp.json()

const resp = await fetch(
  `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records?page_size=10`,
  { headers: { Authorization: `Bearer ${tenant_access_token}` } },
)
const data = await resp.json()
console.log('total:', data.data?.total)
console.log('items count:', data.data?.items?.length)
console.log('---所有记录---')
data.data?.items?.forEach((item, i) => {
  console.log(`\n记录 ${i + 1} (${item.record_id}):`)
  console.log(JSON.stringify(item.fields, null, 2))
})
