// ============================================================
// sync-handler 单元测试（RED）
// ============================================================
// Sprint B-2b：sync 命令 MVP（读飞书 + 单条手动 update-status）
//
// runSyncCommand 行为契约：
//   - mode='list'（默认）：读飞书 + 按状态分组输出分布
//   - mode='filter'（--status <s>）：只输出指定状态的记录
//   - mode='update'（--update-status <id> <s>）：单条更新飞书
//   - 缺配置 → missing_config（不抛）
//   - 飞书失败 → fail + reason（不抛）
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ============================================================
// Mock 依赖（在 import handler 之前）
// ============================================================

const mockListRecords = vi.fn()
const mockUpdateRecord = vi.fn()
const mockLoadConfig = vi.fn()

vi.mock('../../feishu/index.js', () => ({
  listRecords: mockListRecords,
  updateRecord: mockUpdateRecord,
}))

vi.mock('../../config/index.js', () => ({
  loadConfig: mockLoadConfig,
}))

// ============================================================
// 动态 import（mock 之后）
// ============================================================

async function freshHandler() {
  vi.resetModules()
  return await import('./sync-handler.js')
}

// ============================================================
// 测试
// ============================================================

const SAMPLE_RECORDS = {
  code: 0,
  msg: 'ok',
  data: {
    items: [
      { record_id: 'rec_001', fields: { 职位: '前端工程师', 公司: 'A', 状态: '待投递' } },
      { record_id: 'rec_002', fields: { 职位: '后端工程师', 公司: 'B', 状态: '待投递' } },
      { record_id: 'rec_003', fields: { 职位: '全栈工程师', 公司: 'C', 状态: '已沟通' } },
      { record_id: 'rec_004', fields: { 职位: 'DevOps', 公司: 'D', 状态: '不合适' } },
      { record_id: 'rec_005', fields: { 职位: '数据工程师', 公司: 'E', 状态: '已沟通' } },
    ],
  },
}

function makeLoadedConfig() {
  return {
    feishu: { appId: 'cli_x', appSecret: 'sec_x', appToken: 'appTok', tableId: 'tblId' },
    llm: { provider: 'deepseek' as const },
    boss: {},
    browser: {},
  }
}

describe('runSyncCommand — 默认模式（按状态分组）', () => {
  beforeEach(() => {
    mockListRecords.mockReset()
    mockUpdateRecord.mockReset()
    mockLoadConfig.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('读取全部记录并按状态分组输出', async () => {
    mockLoadConfig.mockReturnValue(makeLoadedConfig())
    mockListRecords.mockResolvedValue(SAMPLE_RECORDS)

    const { runSyncCommand } = await freshHandler()
    const result = await runSyncCommand({ mode: 'list' })

    if (result.action !== 'list') throw new Error(`expected list, got ${result.action}`)
    expect(result.totalCount).toBe(5)
    // 状态分布：待投递=2, 已沟通=2, 不合适=1
    expect(result.distribution['待投递']).toBe(2)
    expect(result.distribution['已沟通']).toBe(2)
    expect(result.distribution['不合适']).toBe(1)
    // 输出包含所有状态
    expect(result.formatted).toContain('待投递: 2')
    expect(result.formatted).toContain('已沟通: 2')
    expect(result.formatted).toContain('不合适: 1')
  })

  it('空记录返回友好提示', async () => {
    mockLoadConfig.mockReturnValue(makeLoadedConfig())
    mockListRecords.mockResolvedValue({ code: 0, msg: 'ok', data: { items: [] } })

    const { runSyncCommand } = await freshHandler()
    const result = await runSyncCommand({ mode: 'list' })

    if (result.action !== 'list') throw new Error(`expected list, got ${result.action}`)
    expect(result.totalCount).toBe(0)
    expect(result.distribution).toEqual({})
    expect(result.formatted).toMatch(/暂无|空|没有/)
  })
})

describe('runSyncCommand — --status 筛选', () => {
  beforeEach(() => {
    mockListRecords.mockReset()
    mockUpdateRecord.mockReset()
    mockLoadConfig.mockReset()
  })

  it('--status 只输出指定状态的记录', async () => {
    mockLoadConfig.mockReturnValue(makeLoadedConfig())
    mockListRecords.mockResolvedValue(SAMPLE_RECORDS)

    const { runSyncCommand } = await freshHandler()
    const result = await runSyncCommand({ mode: 'filter', status: '已沟通' })

    if (result.action !== 'list') throw new Error(`expected list, got ${result.action}`)
    // 只显示已沟通的 2 条
    expect(result.totalCount).toBe(2)
    expect(result.formatted).toContain('全栈工程师')
    expect(result.formatted).toContain('数据工程师')
    expect(result.formatted).not.toContain('前端工程师') // 待投递，不该出现
  })

  it('--status 无匹配时返回 0 条', async () => {
    mockLoadConfig.mockReturnValue(makeLoadedConfig())
    mockListRecords.mockResolvedValue(SAMPLE_RECORDS)

    const { runSyncCommand } = await freshHandler()
    const result = await runSyncCommand({ mode: 'filter', status: '已offer' })

    if (result.action !== 'list') throw new Error(`expected list, got ${result.action}`)
    expect(result.totalCount).toBe(0)
  })
})

describe('runSyncCommand — --update-status 单条更新', () => {
  beforeEach(() => {
    mockListRecords.mockReset()
    mockUpdateRecord.mockReset()
    mockLoadConfig.mockReset()
  })

  it('更新成功返回 ok + 新的 recordId/status', async () => {
    mockLoadConfig.mockReturnValue(makeLoadedConfig())
    mockUpdateRecord.mockResolvedValue({ code: 0, msg: 'ok' })

    const { runSyncCommand } = await freshHandler()
    const result = await runSyncCommand({
      mode: 'update',
      recordId: 'rec_001',
      status: '已沟通',
    })

    if (result.action !== 'ok') throw new Error(`expected ok, got ${result.action}`)
    expect(result.recordId).toBe('rec_001')
    expect(result.status).toBe('已沟通')
    // 验证 updateRecord 被正确调用
    expect(mockUpdateRecord).toHaveBeenCalledWith(
      'appTok',
      'tblId',
      'rec_001',
      { 状态: '已沟通' },
    )
  })

  it('缺 recordId 返回 invalid_args', async () => {
    mockLoadConfig.mockReturnValue(makeLoadedConfig())

    const { runSyncCommand } = await freshHandler()
    const result = await runSyncCommand({ mode: 'update', status: '已沟通' } as any)

    expect(result.action).toBe('invalid_args')
    if (result.action !== 'invalid_args') throw new Error('unreachable')
    expect(result.reason).toMatch(/recordId|record_id|record/)
    // 不应调 updateRecord
    expect(mockUpdateRecord).not.toHaveBeenCalled()
  })

  it('缺 status 返回 invalid_args', async () => {
    mockLoadConfig.mockReturnValue(makeLoadedConfig())

    const { runSyncCommand } = await freshHandler()
    const result = await runSyncCommand({ mode: 'update', recordId: 'rec_001' } as any)

    expect(result.action).toBe('invalid_args')
    if (result.action !== 'invalid_args') throw new Error('unreachable')
    expect(mockUpdateRecord).not.toHaveBeenCalled()
  })

  it('飞书 updateRecord 失败返回 fail + reason', async () => {
    mockLoadConfig.mockReturnValue(makeLoadedConfig())
    mockUpdateRecord.mockRejectedValue(new Error('权限不足'))

    const { runSyncCommand } = await freshHandler()
    const result = await runSyncCommand({
      mode: 'update',
      recordId: 'rec_001',
      status: '已沟通',
    })

    expect(result.action).toBe('fail')
    if (result.action !== 'fail') throw new Error('unreachable')
    expect(result.reason).toContain('权限不足')
  })
})

describe('runSyncCommand — 配置检查', () => {
  beforeEach(() => {
    mockListRecords.mockReset()
    mockUpdateRecord.mockReset()
    mockLoadConfig.mockReset()
  })

  it('缺 appToken/tableId 返回 missing_config（任何模式）', async () => {
    mockLoadConfig.mockReturnValue({
      feishu: { appId: 'cli_x', appSecret: 'sec_x', appToken: '', tableId: '' },
      llm: { provider: 'deepseek' as const },
      boss: {},
      browser: {},
    })

    const { runSyncCommand } = await freshHandler()
    const result = await runSyncCommand({ mode: 'list' })

    expect(result.action).toBe('missing_config')
    if (result.action !== 'missing_config') throw new Error('unreachable')
    expect(mockListRecords).not.toHaveBeenCalled()
    expect(mockUpdateRecord).not.toHaveBeenCalled()
  })
})