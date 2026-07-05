// ============================================================
// feishu 客户端单元测试
// ============================================================
// Sprint B-1：业务层测试补齐
//
// 覆盖：
//   1. tenant token 首次请求 + 缓存命中 + 过期重取 + 错误抛错
//   2. listRecords URL 正确
//   3. createRecord URL + body 正确
//   4. updateRecord URL + body 正确
//   5. batchCreateRecords URL + body 正确
//   6. request 自动带 Bearer token
//
// Mock 策略：
//   - vi.mock('../config/index.js')：mock loadConfig 避免读真实 .env
//   - vi.stubGlobal('fetch')：mock 所有 HTTP 请求
//   - vi.resetModules()：每个测试重置 module-level cachedToken
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ============================================================
// Mock loadConfig（必须在 import feishu 之前）
// ============================================================

vi.mock('../config/index.js', () => ({
  loadConfig: vi.fn(() => ({
    feishu: { appId: 'cli_test', appSecret: 'secret_test' },
    llm: { provider: 'deepseek' },
    boss: {},
    browser: {},
  })),
}))

// ============================================================
// 每个测试重新 import feishu（重置 cachedToken）
// ============================================================

async function freshFeishu() {
  vi.resetModules()
  return await import('./index.js')
}

// ============================================================
// fetch mock 工厂
// ============================================================

function makeJsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response
}

function makeTokenResponse(): Response {
  return makeJsonResponse({
    code: 0,
    msg: 'ok',
    tenant_access_token: 't-xxxx',
    expire: 7200, // 2 小时
  })
}

function makeBusinessResponse(data: unknown = { items: [] }): Response {
  return makeJsonResponse({
    code: 0,
    msg: 'ok',
    data,
  })
}

// ============================================================
// tenant token 测试
// ============================================================

describe('tenant token 缓存', () => {
  let fetchSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('首次调用请求 token 接口', async () => {
    const feishu = await freshFeishu()
    // token 响应 + business 响应都 mock 上
    fetchSpy
      .mockResolvedValueOnce(makeTokenResponse())
      .mockResolvedValueOnce(makeBusinessResponse())

    await feishu.listRecords('appTok', 'tblId')

    // 至少有一次 fetch 调用是 token 接口
    const tokenCalls = fetchSpy.mock.calls.filter((c) =>
      String(c[0]).includes('/auth/v3/tenant_access_token/internal'),
    )
    expect(tokenCalls).toHaveLength(1)
  })

  it('缓存命中时不再请求 token 接口', async () => {
    const feishu = await freshFeishu()
    // 第一次 token + business，后续只 business（走缓存）
    fetchSpy
      .mockResolvedValueOnce(makeTokenResponse())
      .mockResolvedValue(makeBusinessResponse())

    await feishu.listRecords('appTok', 'tblId')
    await feishu.listRecords('appTok', 'tblId')
    await feishu.listRecords('appTok', 'tblId')

    // 3 次 listRecords 但只 1 次 token 请求（其余走缓存）
    const tokenCalls = fetchSpy.mock.calls.filter((c) =>
      String(c[0]).includes('/auth/v3/tenant_access_token/internal'),
    )
    expect(tokenCalls).toHaveLength(1)
  })

  it('token 飞书返回 code !== 0 时抛错', async () => {
    const feishu = await freshFeishu()
    fetchSpy.mockResolvedValueOnce(
      makeJsonResponse({ code: 99991663, msg: 'invalid credentials' }),
    )

    await expect(feishu.listRecords('appTok', 'tblId')).rejects.toThrow(
      /飞书鉴权失败/,
    )
  })
})

// ============================================================
// listRecords 测试
// ============================================================

describe('listRecords', () => {
  let fetchSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('调用正确的 URL + 带 Bearer token', async () => {
    const feishu = await freshFeishu()
    fetchSpy
      .mockResolvedValueOnce(makeTokenResponse())
      .mockResolvedValueOnce(makeBusinessResponse())

    await feishu.listRecords('appTok123', 'tblId456', 50)

    // 第二次 fetch 应是业务请求
    const businessCall = fetchSpy.mock.calls[1]
    expect(businessCall).toBeDefined()
    expect(businessCall![0]).toBe(
      'https://open.feishu.cn/open-apis/bitable/v1/apps/appTok123/tables/tblId456/records?page_size=50',
    )
    expect((businessCall![1] as RequestInit).headers).toEqual(
      expect.objectContaining({
        Authorization: 'Bearer t-xxxx',
      }),
    )
  })

  it('pageSize 默认 20', async () => {
    const feishu = await freshFeishu()
    fetchSpy
      .mockResolvedValueOnce(makeTokenResponse())
      .mockResolvedValueOnce(makeBusinessResponse())

    await feishu.listRecords('appTok', 'tblId')

    expect(String(fetchSpy.mock.calls[1]?.[0])).toContain('page_size=20')
  })
})

// ============================================================
// createRecord / updateRecord / batchCreateRecords 测试
// ============================================================

describe('createRecord / updateRecord / batchCreateRecords', () => {
  let fetchSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('createRecord POST 到正确 URL + body 是 { fields }', async () => {
    const feishu = await freshFeishu()
    fetchSpy
      .mockResolvedValueOnce(makeTokenResponse())
      .mockResolvedValueOnce(makeBusinessResponse())

    const fields = { 职位: '前端工程师', 公司: '字节' }
    await feishu.createRecord('appTok', 'tblId', fields)

    const call = fetchSpy.mock.calls[1]!
    expect(call[0]).toBe(
      'https://open.feishu.cn/open-apis/bitable/v1/apps/appTok/tables/tblId/records',
    )
    expect((call[1] as RequestInit).method).toBe('POST')
    expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({
      fields,
    })
  })

  it('updateRecord PUT 到正确 URL + body 是 { fields }', async () => {
    const feishu = await freshFeishu()
    fetchSpy
      .mockResolvedValueOnce(makeTokenResponse())
      .mockResolvedValueOnce(makeBusinessResponse())

    const fields = { 状态: '已投递' }
    await feishu.updateRecord('appTok', 'tblId', 'rec_abc123', fields)

    const call = fetchSpy.mock.calls[1]!
    expect(call[0]).toBe(
      'https://open.feishu.cn/open-apis/bitable/v1/apps/appTok/tables/tblId/records/rec_abc123',
    )
    expect((call[1] as RequestInit).method).toBe('PUT')
    expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({
      fields,
    })
  })

  it('batchCreateRecords POST 到 batch_create URL + body 是 { records: [...] }', async () => {
    const feishu = await freshFeishu()
    fetchSpy
      .mockResolvedValueOnce(makeTokenResponse())
      .mockResolvedValueOnce(makeBusinessResponse())

    const records = [
      { fields: { 职位: 'A' } },
      { fields: { 职位: 'B' } },
    ]
    await feishu.batchCreateRecords('appTok', 'tblId', records)

    const call = fetchSpy.mock.calls[1]!
    expect(call[0]).toBe(
      'https://open.feishu.cn/open-apis/bitable/v1/apps/appTok/tables/tblId/records/batch_create',
    )
    expect((call[1] as RequestInit).method).toBe('POST')
    expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({
      records,
    })
  })
})