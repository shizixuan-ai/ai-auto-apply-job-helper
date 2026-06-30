// ============================================================
// 飞书多维表格 API 客户端
// ============================================================
// 职责：获取 tenant access token → 操作多维表格（CRUD）
// 表结构在首次运行时自动创建
// ============================================================

import { loadConfig } from '../config/index.js'

const FEISHU_BASE = 'https://open.feishu.cn/open-apis'

interface TenantTokenResponse {
  code: number
  msg: string
  tenant_access_token: string
  expire: number
}

let cachedToken: { token: string; expireAt: number } | null = null

/** 获取 tenant access token（带缓存） */
async function getTenantToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expireAt) {
    return cachedToken.token
  }

  const config = loadConfig()
  const res = await fetch(`${FEISHU_BASE}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      app_id: config.feishu.appId,
      app_secret: config.feishu.appSecret,
    }),
  })

  const body = (await res.json()) as TenantTokenResponse
  if (body.code !== 0) {
    throw new Error(`飞书鉴权失败: ${body.msg}`)
  }

  cachedToken = {
    token: body.tenant_access_token,
    expireAt: Date.now() + body.expire * 1000 - 60_000, // 提前 1 分钟过期
  }
  return cachedToken.token
}

/** 通用 API 请求封装 */
async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const token = await getTenantToken()
  const res = await fetch(`${FEISHU_BASE}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json()
  return data as T
}

// ============================================================
// 公开 API
// ============================================================

/** 列出多维表格的记录 */
export async function listRecords(
  appToken: string,
  tableId: string,
  pageSize = 20,
) {
  return request<any>('GET',
    `/bitable/v1/apps/${appToken}/tables/${tableId}/records?page_size=${pageSize}`,
  )
}

/** 创建一条记录 */
export async function createRecord(
  appToken: string,
  tableId: string,
  fields: Record<string, unknown>,
) {
  return request<any>('POST',
    `/bitable/v1/apps/${appToken}/tables/${tableId}/records`,
    { fields },
  )
}

/** 更新一条记录 */
export async function updateRecord(
  appToken: string,
  tableId: string,
  recordId: string,
  fields: Record<string, unknown>,
) {
  return request<any>('PUT',
    `/bitable/v1/apps/${appToken}/tables/${tableId}/records/${recordId}`,
    { fields },
  )
}

/** 批量创建记录 */
export async function batchCreateRecords(
  appToken: string,
  tableId: string,
  records: Array<{ fields: Record<string, unknown> }>,
) {
  return request<any>('POST',
    `/bitable/v1/apps/${appToken}/tables/${tableId}/records/batch_create`,
    { records },
  )
}
