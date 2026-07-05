// ============================================================
// stats-handler 单元测试（RED）
// ============================================================
// Sprint B-2c：stats 命令（MVP：总数/状态分布/漏斗/Top 公司）
//
// runStatsCommand 行为契约：
//   - 读飞书全部记录 → 聚合统计
//   - 输出：总数 + 状态分布 + 投递率/沟通率 + Top 5 公司
//   - 缺配置 → missing_config（不抛）
//   - 飞书失败 → fail（不抛）
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ============================================================
// Mock 依赖
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
// 动态 import
// ============================================================

async function freshHandler() {
  vi.resetModules()
  return await import('./stats-handler.js')
}

// ============================================================
// 测试数据
// ============================================================

function makeLoadedConfig() {
  return {
    feishu: { appId: 'cli_x', appSecret: 'sec_x', appToken: 'appTok', tableId: 'tblId' },
    llm: { provider: 'deepseek' as const },
    boss: {},
    browser: {},
  }
}

const SAMPLE = {
  code: 0,
  msg: 'ok',
  data: {
    items: [
      { record_id: 'r1', fields: { 职位: '前端A', 公司: '字节跳动', 状态: '已沟通' } },
      { record_id: 'r2', fields: { 职位: '前端B', 公司: '字节跳动', 状态: '已投递' } },
      { record_id: 'r3', fields: { 职位: '后端A', 公司: '字节跳动', 状态: '待投递' } },
      { record_id: 'r4', fields: { 职位: '全栈A', 公司: '美团', 状态: '已沟通' } },
      { record_id: 'r5', fields: { 职位: '全栈B', 公司: '美团', 状态: '已沟通' } },
      { record_id: 'r6', fields: { 职位: '运维A', 公司: '腾讯', 状态: '已投递' } },
      { record_id: 'r7', fields: { 职位: '运维B', 公司: '腾讯', 状态: '不合适' } },
      { record_id: 'r8', fields: { 职位: '数据A', 公司: '阿里', 状态: '不合适' } },
      { record_id: 'r9', fields: { 职位: '数据B', 公司: '阿里', 状态: '待投递' } },
      { record_id: 'r10', fields: { 职位: '测试A', 公司: '阿里', 状态: '已投递' } },
    ],
  },
}

// 期望的统计：
// 总数: 10
// 状态分布: 已沟通=3, 已投递=3, 待投递=2, 不合适=2
// 已投递率: 6/10 = 60%
// 沟通率: 3/6 = 50% (3 已沟通 / 6 已投递)
// Top 公司: 阿里=3, 字节跳动=3, 美团=2, 腾讯=2

describe('runStatsCommand', () => {
  beforeEach(() => {
    mockListRecords.mockReset()
    mockLoadConfig.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('缺 appToken/tableId 返回 missing_config（不调 listRecords）', async () => {
    mockLoadConfig.mockReturnValue({
      feishu: { appId: 'cli_x', appSecret: 'sec_x', appToken: '', tableId: '' },
      llm: { provider: 'deepseek' as const },
      boss: {},
      browser: {},
    })

    const { runStatsCommand } = await freshHandler()
    const result = await runStatsCommand({})

    expect(result.action).toBe('missing_config')
    if (result.action !== 'missing_config') throw new Error('unreachable')
    expect(mockListRecords).not.toHaveBeenCalled()
  })

  it('输出总数 + 状态分布', async () => {
    mockLoadConfig.mockReturnValue(makeLoadedConfig())
    mockListRecords.mockResolvedValue(SAMPLE)

    const { runStatsCommand } = await freshHandler()
    const result = await runStatsCommand({})

    expect(result.action).toBe('ok')
    if (result.action !== 'ok') throw new Error('unreachable')

    expect(result.totalCount).toBe(10)
    // 状态分布（按数量降序）
    expect(result.distribution['已沟通']).toBe(3)
    expect(result.distribution['已投递']).toBe(3)
    expect(result.distribution['待投递']).toBe(2)
    expect(result.distribution['不合适']).toBe(2)

    // 输出包含所有数字
    expect(result.formatted).toContain('总岗位数')
    expect(result.formatted).toContain('10')
    expect(result.formatted).toMatch(/已沟通.*3/)
  })

  it('输出投递率 + 沟通率（漏斗百分比）', async () => {
    mockLoadConfig.mockReturnValue(makeLoadedConfig())
    mockListRecords.mockResolvedValue(SAMPLE)

    const { runStatsCommand } = await freshHandler()
    const result = await runStatsCommand({})

    if (result.action !== 'ok') throw new Error('unreachable')

    // 投递率: (已投递 + 已沟通) / 总数 = 6/10 = 60%
    expect(result.applyRate).toBeCloseTo(0.6, 2)
    // 沟通率: 已沟通 / 已投递总数 = 3/6 = 50%
    expect(result.replyRate).toBeCloseTo(0.5, 2)

    expect(result.formatted).toMatch(/投递率.*60/)
    expect(result.formatted).toMatch(/沟通率.*50/)
  })

  it('Top 5 公司按数量降序输出', async () => {
    mockLoadConfig.mockReturnValue(makeLoadedConfig())
    mockListRecords.mockResolvedValue(SAMPLE)

    const { runStatsCommand } = await freshHandler()
    const result = await runStatsCommand({})

    if (result.action !== 'ok') throw new Error('unreachable')

    // 阿里=3, 字节跳动=3, 美团=2, 腾讯=2
    expect(result.topCompanies.length).toBeGreaterThanOrEqual(2)
    expect(result.topCompanies[0]).toEqual(expect.objectContaining({ 公司: '阿里', count: 3 }))
    expect(result.topCompanies[1]).toEqual(expect.objectContaining({ 公司: '字节跳动', count: 3 }))

    expect(result.formatted).toMatch(/阿里.*3/)
    expect(result.formatted).toMatch(/字节跳动.*3/)
  })

  it('空记录返回友好提示 + 0% 比例', async () => {
    mockLoadConfig.mockReturnValue(makeLoadedConfig())
    mockListRecords.mockResolvedValue({ code: 0, msg: 'ok', data: { items: [] } })

    const { runStatsCommand } = await freshHandler()
    const result = await runStatsCommand({})

    expect(result.action).toBe('ok')
    if (result.action !== 'ok') throw new Error('unreachable')

    expect(result.totalCount).toBe(0)
    expect(result.applyRate).toBe(0)
    expect(result.replyRate).toBe(0)
    expect(result.formatted).toMatch(/暂无|空|没有/)
  })

  it('飞书失败返回 fail（不抛）', async () => {
    mockLoadConfig.mockReturnValue(makeLoadedConfig())
    mockListRecords.mockRejectedValue(new Error('网络超时'))

    const { runStatsCommand } = await freshHandler()
    const result = await runStatsCommand({})

    expect(result.action).toBe('fail')
    if (result.action !== 'fail') throw new Error('unreachable')
    expect(result.reason).toContain('网络超时')
  })
})