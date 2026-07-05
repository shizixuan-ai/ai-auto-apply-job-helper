// ============================================================
// list-handler 单元测试（RED）
// ============================================================
// Sprint B-2a：CLI handler 落地
//
// runListCommand 行为契约：
//   1. 调 listRecords 拉取数据
//   2. 格式化为人类可读文本
//   3. 返回结构化结果（status + records + formatted）
//   4. 未配置 appToken/tableId → 返回 missing_config 状态，不抛
//   5. 飞书调用失败 → 返回 fail 状态 + 错误信息
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ============================================================
// Mock 依赖（在 import handler 之前）
// ============================================================

const mockListRecords = vi.fn()
const mockLoadConfig = vi.fn()

vi.mock('../../feishu/index.js', () => ({
  listRecords: mockListRecords,
}))

vi.mock('../../config/index.js', () => ({
  loadConfig: mockLoadConfig,
}))

// ============================================================
// 动态 import（mock 之后）
// ============================================================

async function freshHandler() {
  vi.resetModules()
  return await import('./list-handler.js')
}

// ============================================================
// 测试
// ============================================================

describe('runListCommand', () => {
  beforeEach(() => {
    mockListRecords.mockReset()
    mockLoadConfig.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('缺 appToken/tableId 时返回 missing_config 状态（不抛）', async () => {
    mockLoadConfig.mockReturnValue({
      feishu: { appId: 'cli_x', appSecret: 'sec_x', appToken: '', tableId: '' },
      llm: { provider: 'deepseek' },
      boss: {},
      browser: {},
    })

    const { runListCommand } = await freshHandler()
    const result = await runListCommand({ limit: 20 })

    expect(result.action).toBe('missing_config')
    expect(mockListRecords).not.toHaveBeenCalled()
  })

  it('正常返回数据时格式化输出每条记录', async () => {
    mockLoadConfig.mockReturnValue({
      feishu: { appId: 'cli_x', appSecret: 'sec_x', appToken: 'appTok', tableId: 'tblId' },
      llm: { provider: 'deepseek' },
      boss: {},
      browser: {},
    })
    mockListRecords.mockResolvedValue({
      code: 0,
      msg: 'ok',
      data: {
        items: [
          {
            record_id: 'rec_001',
            fields: {
              职位: '前端工程师',
              公司: '字节跳动',
              薪资: '30-50K',
              城市: '杭州',
              状态: '待投递',
            },
          },
          {
            record_id: 'rec_002',
            fields: {
              职位: '高级前端',
              公司: '美团',
              状态: '已投递',
            },
          },
        ],
      },
    })

    const { runListCommand } = await freshHandler()
    const result = await runListCommand({ limit: 20 })

    expect(result.action).toBe('ok')
    if (result.action !== 'ok') throw new Error(`expected ok, got ${result.action}`)

    // 收窄后访问 ok 分支专属字段
    expect(result.recordCount).toBe(2)
    // 格式化输出包含关键字段
    expect(result.formatted).toContain('前端工程师')
    expect(result.formatted).toContain('字节跳动')
    expect(result.formatted).toContain('30-50K')
    expect(result.formatted).toContain('杭州')
    expect(result.formatted).toContain('待投递')
  })

  it('空列表时返回友好提示', async () => {
    mockLoadConfig.mockReturnValue({
      feishu: { appId: 'cli_x', appSecret: 'sec_x', appToken: 'appTok', tableId: 'tblId' },
      llm: { provider: 'deepseek' },
      boss: {},
      browser: {},
    })
    mockListRecords.mockResolvedValue({
      code: 0,
      msg: 'ok',
      data: { items: [] },
    })

    const { runListCommand } = await freshHandler()
    const result = await runListCommand({ limit: 20 })

    expect(result.action).toBe('ok')
    if (result.action !== 'ok') throw new Error(`expected ok, got ${result.action}`)

    expect(result.recordCount).toBe(0)
    // 友好提示而非空字符串
    expect(result.formatted).toMatch(/暂无|空|没有|先跑.*search/)
  })

  it('飞书调用失败时返回 fail 状态', async () => {
    mockLoadConfig.mockReturnValue({
      feishu: { appId: 'cli_x', appSecret: 'sec_x', appToken: 'appTok', tableId: 'tblId' },
      llm: { provider: 'deepseek' },
      boss: {},
      browser: {},
    })
    mockListRecords.mockRejectedValue(new Error('飞书 API 超时'))

    const { runListCommand } = await freshHandler()
    const result = await runListCommand({ limit: 20 })

    expect(result.action).toBe('fail')
    if (result.action !== 'fail') throw new Error(`expected fail, got ${result.action}`)

    expect(result.reason).toContain('飞书 API 超时')
  })

  it('limit 参数透传给 listRecords', async () => {
    mockLoadConfig.mockReturnValue({
      feishu: { appId: 'cli_x', appSecret: 'sec_x', appToken: 'appTok', tableId: 'tblId' },
      llm: { provider: 'deepseek' },
      boss: {},
      browser: {},
    })
    mockListRecords.mockResolvedValue({
      code: 0,
      msg: 'ok',
      data: { items: [] },
    })

    const { runListCommand } = await freshHandler()
    await runListCommand({ limit: 50 })

    expect(mockListRecords).toHaveBeenCalledWith('appTok', 'tblId', 50)
  })
})