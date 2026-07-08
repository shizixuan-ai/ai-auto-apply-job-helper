// 临时脚本：列出飞书表里现存记录的 fields（key 即字段名）
// 用法：npx tsx scripts/inspect-feishu.mjs

import 'dotenv/config'
import { listRecords } from '../src/feishu/index.ts'

const appToken = process.env.FEISHU_APP_TOKEN
const tableId = process.env.FEISHU_TABLE_ID
console.log('appToken:', appToken)
console.log('tableId:', tableId)
console.log('')

try {
  const records = await listRecords(appToken, tableId, undefined, 5)
  console.log(`=== 现存 ${records?.length ?? 0} 条记录的 fields keys ===`)

  if (records && records.length > 0) {
    const allKeys = new Set()
    records.forEach((r, i) => {
      const keys = Object.keys(r.fields ?? {})
      console.log(`  记录 ${i + 1}: ${keys.join(', ')}`)
      keys.forEach((k) => allKeys.add(k))
    })
    console.log('')
    console.log('=== 所有出现过的字段名（去重）===')
    Array.from(allKeys).sort().forEach((k) => console.log(`  ${k}`))
  } else {
    console.log('（表里没记录，无法看字段名）')
    console.log('   → 你需要去飞书后台加几条测试数据，或者告诉我字段名')
  }
} catch (e) {
  console.log('listRecords 失败:', e.message)
  console.log('  → 可能是 FEISHU_APP_TOKEN/TABLE_ID 配错，或权限不足')
}
