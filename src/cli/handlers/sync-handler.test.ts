// ============================================================
// sync-handler 单元测试（RED）
// ============================================================
// Sprint B-2b：sync 命令 MVP（读飞书 + 单条手动 update-status）
// Sprint B-2b-2：sync --auto-greet 模式（自动调 BOSS 打招呼 + 回写飞书）
//
// runSyncCommand 行为契约：
//   - mode='list'（默认）：读飞书 + 按状态分组输出分布
//   - mode='filter'（--status <s>）：只输出指定状态的记录
//   - mode='update'（--update-status <id> <s>）：单条更新飞书
//   - mode='auto-greet'（--auto-greet）：批量调 BOSS 打招呼 + 回写飞书
//   - 缺配置 → missing_config（不抛）
//   - 飞书/BOSS 失败 → fail（auto-greet 模式为 per-job errors）
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ============================================================
// Mock 依赖（在 import handler 之前）
// ============================================================

const mockListRecords = vi.fn()
const mockUpdateRecord = vi.fn()
const mockLoadConfig = vi.fn()
const mockRunSendCommand = vi.fn()

vi.mock('../../feishu/index.js', () => ({
  listRecords: mockListRecords,
  updateRecord: mockUpdateRecord,
}))

vi.mock('../../config/index.js', () => ({
  loadConfig: mockLoadConfig,
}))

vi.mock('./send-handler.js', () => ({
  runSendCommand: mockRunSendCommand,
}))

// ============================================================
// auto-greet helper: generateGreeting mock 默认值
// ============================================================
//
/** 默认 generateGreeting mock：每个 jobId → "Hi ${jobId}, 我对贵岗位很感兴趣" */
const makeDefaultMockGenerateGreeting = () =>
  vi.fn().mockImplementation(async (jobId: string) => `Hi ${jobId}, 我对贵岗位很感兴趣`)

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

// ============================================================
// runSyncCommand — auto-greet 模式（Sprint B-2b-2）
// ============================================================
// 行为契约：
//   - 读飞书『待投递』岗位（limit 默认 5）
//   - 对每个岗位调 runSendCommand
//   - runSendCommand 成功 → updateRecord『已投递』
//   - runSendCommand 失败 → errors.push，不中断，继续下一个
//   - 全程不抛异常
// ============================================================

describe('runSyncCommand — auto-greet 模式', () => {
  // 每个测试共用的 generateGreeting mock
  // （默认每个 jobId → "Hi jobId"；个别测试用 mockRejectedValueOnce 模拟失败）
  let mockGenerateGreeting: ReturnType<typeof makeDefaultMockGenerateGreeting>

  beforeEach(() => {
    mockListRecords.mockReset()
    mockUpdateRecord.mockReset()
    mockLoadConfig.mockReset()
    mockRunSendCommand.mockReset()
    mockGenerateGreeting = makeDefaultMockGenerateGreeting()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  /** 注入 generateGreeting mock 的便捷 helper */
  async function runAutoGreet(handler: any, opts: any) {
    return await handler.runSyncCommand(opts, { generateGreeting: mockGenerateGreeting })
  }

  // 待投递岗位样本（3 条）
  const PENDING_RECORDS = {
    code: 0,
    msg: 'ok',
    data: {
      items: [
        { record_id: 'rec_p1', fields: { 职位: '前端A', 公司: '字节', 状态: '待投递' } },
        { record_id: 'rec_p2', fields: { 职位: '前端B', 公司: '美团', 状态: '待投递' } },
        { record_id: 'rec_p3', fields: { 职位: '前端C', 公司: '腾讯', 状态: '待投递' } },
        { record_id: 'rec_other', fields: { 职位: '运维', 公司: '阿里', 状态: '已沟通' } }, // 非待投递
      ],
    },
  }

  it('缺配置返回 missing_config（不调 listRecords / runSendCommand）', async () => {
    mockLoadConfig.mockReturnValue({
      feishu: { appId: 'cli_x', appSecret: 'sec_x', appToken: '', tableId: '' },
      llm: { provider: 'deepseek' as const },
      boss: {},
      browser: {},
    })

    const { runSyncCommand } = await freshHandler()
    const result = await runSyncCommand({ mode: 'auto-greet' }, { generateGreeting: mockGenerateGreeting })

    expect(result.action).toBe('missing_config')
    if (result.action !== 'missing_config') throw new Error('unreachable')
    expect(mockListRecords).not.toHaveBeenCalled()
    expect(mockRunSendCommand).not.toHaveBeenCalled()
  })

  it('只处理『待投递』岗位，忽略其他状态', async () => {
    mockLoadConfig.mockReturnValue(makeLoadedConfig())
    mockListRecords.mockResolvedValue(PENDING_RECORDS)
    mockRunSendCommand.mockResolvedValue({ action: 'ok', reason: '已打招呼' })
    mockUpdateRecord.mockResolvedValue({ code: 0, msg: 'ok' })

    const { runSyncCommand } = await freshHandler()
    const result = await runSyncCommand({ mode: 'auto-greet', limit: 10 }, { generateGreeting: mockGenerateGreeting })

    expect(result.action).toBe('auto-greet')
    if (result.action !== 'auto-greet') throw new Error('unreachable')
    // 4 条样本只 3 条『待投递』被处理
    expect(result.total).toBe(3)
    expect(result.succeeded).toBe(3)
    expect(result.failed).toBe(0)
    // runSendCommand 调用 3 次（不含 rec_other）
    expect(mockRunSendCommand).toHaveBeenCalledTimes(3)
    expect(mockRunSendCommand).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'rec_p1', cdp: false }),
    )
    // 成功 → updateRecord『已投递』
    expect(mockUpdateRecord).toHaveBeenCalledTimes(3)
    expect(mockUpdateRecord).toHaveBeenCalledWith(
      'appTok', 'tblId', 'rec_p1', { 状态: '已投递' },
    )
  })

  it('部分 runSendCommand 失败时累积 errors 不中断', async () => {
    mockLoadConfig.mockReturnValue(makeLoadedConfig())
    mockListRecords.mockResolvedValue(PENDING_RECORDS)
    // 第 2 个岗位失败
    mockRunSendCommand
      .mockResolvedValueOnce({ action: 'ok', reason: '已打招呼' })
      .mockResolvedValueOnce({ action: 'failed', reason: 'BOSS 验证码拦截' })
      .mockResolvedValueOnce({ action: 'ok', reason: '已打招呼' })
    mockUpdateRecord.mockResolvedValue({ code: 0, msg: 'ok' })

    const { runSyncCommand } = await freshHandler()
    const result = await runSyncCommand({ mode: 'auto-greet', limit: 10 }, { generateGreeting: mockGenerateGreeting })

    if (result.action !== 'auto-greet') throw new Error('unreachable')
    expect(result.total).toBe(3)
    expect(result.succeeded).toBe(2)
    expect(result.failed).toBe(1)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toEqual(
      expect.objectContaining({ jobId: 'rec_p2', reason: expect.stringContaining('验证码') }),
    )
    // 格式化输出包含失败明细（commit message 承诺的能力）
    expect(result.formatted).toContain('❌ 失败明细')
    expect(result.formatted).toContain('验证码拦截')
    // 只 update 成功的 2 条
    expect(mockUpdateRecord).toHaveBeenCalledTimes(2)
    expect(mockUpdateRecord).not.toHaveBeenCalledWith(
      'appTok', 'tblId', 'rec_p2', expect.anything(),
    )
  })

  it('limit 限制处理数量（默认 5）', async () => {
    mockLoadConfig.mockReturnValue(makeLoadedConfig())
    mockListRecords.mockResolvedValue(PENDING_RECORDS)
    mockRunSendCommand.mockResolvedValue({ action: 'ok', reason: 'ok' })
    mockUpdateRecord.mockResolvedValue({ code: 0, msg: 'ok' })

    const { runSyncCommand } = await freshHandler()
    // 限制只处理 2 条（虽然有 3 条待投递）
    const result = await runSyncCommand({ mode: 'auto-greet', limit: 2 }, { generateGreeting: mockGenerateGreeting })

    if (result.action !== 'auto-greet') throw new Error('unreachable')
    expect(result.total).toBe(2)
    expect(mockRunSendCommand).toHaveBeenCalledTimes(2)
  })

  it('无『待投递』岗位返回 total=0', async () => {
    mockLoadConfig.mockReturnValue(makeLoadedConfig())
    mockListRecords.mockResolvedValue({
      code: 0,
      msg: 'ok',
      data: {
        items: [
          { record_id: 'r1', fields: { 状态: '已沟通' } },
          { record_id: 'r2', fields: { 状态: '不合适' } },
        ],
      },
    })

    const { runSyncCommand } = await freshHandler()
    const result = await runSyncCommand({ mode: 'auto-greet' }, { generateGreeting: mockGenerateGreeting })

    if (result.action !== 'auto-greet') throw new Error('unreachable')
    expect(result.total).toBe(0)
    expect(result.succeeded).toBe(0)
    expect(result.failed).toBe(0)
    expect(mockRunSendCommand).not.toHaveBeenCalled()
  })

  it('全部 runSendCommand 失败时 succeeded=0', async () => {
    mockLoadConfig.mockReturnValue(makeLoadedConfig())
    mockListRecords.mockResolvedValue(PENDING_RECORDS)
    mockRunSendCommand.mockResolvedValue({ action: 'abort', reason: '风控阻断' })

    const { runSyncCommand } = await freshHandler()
    const result = await runSyncCommand({ mode: 'auto-greet', limit: 10 }, { generateGreeting: mockGenerateGreeting })

    if (result.action !== 'auto-greet') throw new Error('unreachable')
    expect(result.total).toBe(3)
    expect(result.succeeded).toBe(0)
    expect(result.failed).toBe(3)
    expect(result.errors).toHaveLength(3)
    expect(mockUpdateRecord).not.toHaveBeenCalled()
  })

  it('listRecords 失败返回 fail', async () => {
    mockLoadConfig.mockReturnValue(makeLoadedConfig())
    mockListRecords.mockRejectedValue(new Error('飞书连接超时'))

    const { runSyncCommand } = await freshHandler()
    const result = await runSyncCommand({ mode: 'auto-greet' }, { generateGreeting: mockGenerateGreeting })

    expect(result.action).toBe('fail')
    if (result.action !== 'fail') throw new Error('unreachable')
    expect(result.reason).toContain('飞书连接超时')
  })

  // ----------------------------------------------------------------
  // 半成功场景：runSendCommand 成功但 updateRecord 失败
  // （commit message 明确描述为设计要点，但 catch 分支 0 覆盖）
  // ----------------------------------------------------------------
  it('半成功：runSendCommand 成功 + updateRecord 抛异常 → 累积到 errors', async () => {
    mockLoadConfig.mockReturnValue(makeLoadedConfig())
    mockListRecords.mockResolvedValue({
      code: 0,
      msg: 'ok',
      data: {
        items: [
          { record_id: 'rec_semi', fields: { 状态: '待投递' } },
        ],
      },
    })
    // runSendCommand 成功（已打招呼）
    mockRunSendCommand.mockResolvedValue({ action: 'ok', reason: '已打招呼' })
    // 但 updateRecord 抛异常（飞书更新失败）
    mockUpdateRecord.mockRejectedValue(new Error('飞书权限不足'))

    const { runSyncCommand } = await freshHandler()
    const result = await runSyncCommand({ mode: 'auto-greet' }, { generateGreeting: mockGenerateGreeting })

    if (result.action !== 'auto-greet') throw new Error('unreachable')
    // 关键：succeeded=0, failed=1（半成功算失败）
    expect(result.total).toBe(1)
    expect(result.succeeded).toBe(0)
    expect(result.failed).toBe(1)
    expect(result.errors).toHaveLength(1)
    // errors[0] 必须包含『飞书更新失败』字样（设计约定的 reason 前缀）
    expect(result.errors[0]).toEqual(
      expect.objectContaining({
        jobId: 'rec_semi',
        reason: expect.stringMatching(/飞书更新失败|权限不足/),
      }),
    )
  })

  it('updateRecord 抛非 Error 实例时也能降级（String(err) 分支）', async () => {
    mockLoadConfig.mockReturnValue(makeLoadedConfig())
    mockListRecords.mockResolvedValue({
      code: 0,
      msg: 'ok',
      data: {
        items: [
          { record_id: 'rec_str', fields: { 状态: '待投递' } },
        ],
      },
    })
    mockRunSendCommand.mockResolvedValue({ action: 'ok', reason: '已打招呼' })
    // 非 Error 实例
    mockUpdateRecord.mockRejectedValue('plain string error')

    const { runSyncCommand } = await freshHandler()
    const result = await runSyncCommand({ mode: 'auto-greet' }, { generateGreeting: mockGenerateGreeting })

    if (result.action !== 'auto-greet') throw new Error('unreachable')
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.reason).toMatch(/plain string error/)
  })

  // ----------------------------------------------------------------
  // P0 fake green 回归测试：暴露 send-handler 在 message 缺失时的真实行为
  //
  // sync-handler.ts:140 调用 runSendCommand({ jobId, message: undefined })
  // send-handler.ts:78-83 在 !opts.message 时立即返回 { action: 'invalid_args' }
  //
  // 上面 7 个测试用 mock 让 runSendCommand 返回 ok → 测试通过
  // 但生产环境 send-handler 会真实返回 invalid_args → auto-greet 100% 失败
  //
  // 这个测试模拟真实 send-handler 行为，证明该 bug：
  // ----------------------------------------------------------------
  it('P0 回归：send 返 invalid_args（真实生产行为）时所有 job 失败', async () => {
    mockLoadConfig.mockReturnValue(makeLoadedConfig())
    mockListRecords.mockResolvedValue(PENDING_RECORDS)
    // 模拟真实 send-handler 在 message=undefined 时的行为
    mockRunSendCommand.mockResolvedValue({
      action: 'invalid_args',
      reason: '请通过 -m 指定话术内容',
    })

    const { runSyncCommand } = await freshHandler()
    const result = await runSyncCommand({ mode: 'auto-greet' }, { generateGreeting: mockGenerateGreeting })

    if (result.action !== 'auto-greet') throw new Error('unreachable')
    // 真实行为：succeeded=0, failed=N, errors 都含 '-m' 提示
    expect(result.total).toBe(3)
    expect(result.succeeded).toBe(0)
    expect(result.failed).toBe(3)
    expect(result.errors).toHaveLength(3)
    expect(result.errors.every((e) => e.reason.includes('-m'))).toBe(true)
    expect(mockUpdateRecord).not.toHaveBeenCalled()
  })

  // ----------------------------------------------------------------
  // B-2b-2 修复（方案 B）：generateGreeting 注入
  // ----------------------------------------------------------------

  it('每个 job 先调 generateGreeting，message 透传给 runSendCommand', async () => {
    mockLoadConfig.mockReturnValue(makeLoadedConfig())
    mockListRecords.mockResolvedValue(PENDING_RECORDS)
    mockRunSendCommand.mockResolvedValue({ action: 'ok', reason: 'ok' })
    mockUpdateRecord.mockResolvedValue({ code: 0, msg: 'ok' })

    const { runSyncCommand } = await freshHandler()
    const result = await runSyncCommand({ mode: 'auto-greet', limit: 10 }, { generateGreeting: mockGenerateGreeting })

    if (result.action !== 'auto-greet') throw new Error('unreachable')
    expect(result.succeeded).toBe(3)
    // generateGreeting 被调用 3 次，每个待投递 job 一次
    expect(mockGenerateGreeting).toHaveBeenCalledTimes(3)
    expect(mockGenerateGreeting).toHaveBeenCalledWith('rec_p1')
    expect(mockGenerateGreeting).toHaveBeenCalledWith('rec_p2')
    expect(mockGenerateGreeting).toHaveBeenCalledWith('rec_p3')
    // runSendCommand 收到 mockGenerateGreeting 返回的 message
    expect(mockRunSendCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 'rec_p1',
        message: 'Hi rec_p1, 我对贵岗位很感兴趣',
        cdp: false,
      }),
    )
  })

  it('generateGreeting 失败时累积 errors 且不调 runSendCommand（fail-fast for that job）', async () => {
    mockLoadConfig.mockReturnValue(makeLoadedConfig())
    mockListRecords.mockResolvedValue(PENDING_RECORDS)
    // 第 2 个岗位 generateGreeting 失败
    mockGenerateGreeting
      .mockResolvedValueOnce('msg-1')
      .mockRejectedValueOnce(new Error('LLM rate limit'))
      .mockResolvedValueOnce('msg-3')
    mockRunSendCommand.mockResolvedValue({ action: 'ok', reason: 'ok' })
    mockUpdateRecord.mockResolvedValue({ code: 0, msg: 'ok' })

    const { runSyncCommand } = await freshHandler()
    const result = await runSyncCommand({ mode: 'auto-greet', limit: 10 }, { generateGreeting: mockGenerateGreeting })

    if (result.action !== 'auto-greet') throw new Error('unreachable')
    expect(result.total).toBe(3)
    expect(result.succeeded).toBe(2) // rec_p1, rec_p3 成功
    expect(result.failed).toBe(1)   // rec_p2 generateGreeting 失败
    expect(result.errors[0]).toEqual(
      expect.objectContaining({
        jobId: 'rec_p2',
        reason: expect.stringMatching(/生成招呼语失败.*LLM rate limit/),
      }),
    )
    // runSendCommand 只对 rec_p1 和 rec_p3 调用（rec_p2 跳过）
    expect(mockRunSendCommand).toHaveBeenCalledTimes(2)
    expect(mockRunSendCommand).not.toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'rec_p2' }),
    )
  })

  it('generateGreeting 抛非 Error 实例时降级为 String(err)', async () => {
    mockLoadConfig.mockReturnValue(makeLoadedConfig())
    mockListRecords.mockResolvedValue({
      code: 0,
      msg: 'ok',
      data: {
        items: [{ record_id: 'rec_str', fields: { 状态: '待投递' } }],
      },
    })
    mockGenerateGreeting.mockRejectedValue('plain string error')
    mockRunSendCommand.mockResolvedValue({ action: 'ok', reason: 'ok' })

    const { runSyncCommand } = await freshHandler()
    const result = await runSyncCommand({ mode: 'auto-greet' }, { generateGreeting: mockGenerateGreeting })

    if (result.action !== 'auto-greet') throw new Error('unreachable')
    expect(result.failed).toBe(1)
    expect(result.errors[0]?.reason).toMatch(/plain string error/)
    expect(mockRunSendCommand).not.toHaveBeenCalled()
  })
})

// ============================================================
// runSyncCommand — auto-greet --dry-run 模式（2026-07-07）
// ============================================================
// 行为契约：
//   - 读飞书『待投递』岗位（与普通 auto-greet 一样）
//   - 对每个岗位调 generateGreeting（真实 LLM 调用，验证招呼语质量）
//   - ❌ 不调 runSendCommand（不真实发消息给 BOSS HR）
//   - ❌ 不调 updateRecord（不改飞书状态，避免脏数据）
//   - 返回 action='auto-greet'，但带 dryRun=true 标记 + 生成的招呼语列表
//
// 为什么需要 dry-run：
//   - 用户选择方案 B：先验证 LLM 生成质量，不发真消息
//   - 防止 P0 fake green：旧 fake green 模式下脚本"成功"但实际 HR 没收到招呼
//   - 避免 BOSS 风控：1 小时发 3 条可能被标记
// ============================================================

describe('runSyncCommand — auto-greet --dry-run 模式', () => {
  let mockGenerateGreeting: ReturnType<typeof makeDefaultMockGenerateGreeting>

  beforeEach(() => {
    mockListRecords.mockReset()
    mockUpdateRecord.mockReset()
    mockLoadConfig.mockReset()
    mockRunSendCommand.mockReset()
    mockGenerateGreeting = makeDefaultMockGenerateGreeting()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  const DRY_PENDING_RECORDS = {
    code: 0,
    msg: 'ok',
    data: {
      items: [
        { record_id: 'rec_d1', fields: { 职位: '前端', 公司: '字节', 状态: '待投递' } },
        { record_id: 'rec_d2', fields: { 职位: '后端', 公司: '美团', 状态: '待投递' } },
      ],
    },
  }

  it('dry-run 仍调 generateGreeting（验证 LLM 输出）', async () => {
    mockLoadConfig.mockReturnValue(makeLoadedConfig())
    mockListRecords.mockResolvedValue(DRY_PENDING_RECORDS)

    const { runSyncCommand } = await freshHandler()
    const result = await runSyncCommand(
      { mode: 'auto-greet', dryRun: true },
      { generateGreeting: mockGenerateGreeting },
    )

    expect(result.action).toBe('auto-greet')
    if (result.action !== 'auto-greet') throw new Error('unreachable')
    expect(mockGenerateGreeting).toHaveBeenCalledTimes(2)
    expect(mockGenerateGreeting).toHaveBeenCalledWith('rec_d1')
    expect(mockGenerateGreeting).toHaveBeenCalledWith('rec_d2')
  })

  it('🚨 关键安全属性：dry-run 不调 runSendCommand（不发真消息）', async () => {
    mockLoadConfig.mockReturnValue(makeLoadedConfig())
    mockListRecords.mockResolvedValue(DRY_PENDING_RECORDS)

    const { runSyncCommand } = await freshHandler()
    await runSyncCommand(
      { mode: 'auto-greet', dryRun: true },
      { generateGreeting: mockGenerateGreeting },
    )

    // 🚨 绝不能调 runSendCommand —— 那会向真实 BOSS HR 发消息
    expect(mockRunSendCommand).not.toHaveBeenCalled()
  })

  it('🚨 关键安全属性：dry-run 不调 updateRecord（不改飞书状态）', async () => {
    mockLoadConfig.mockReturnValue(makeLoadedConfig())
    mockListRecords.mockResolvedValue(DRY_PENDING_RECORDS)

    const { runSyncCommand } = await freshHandler()
    await runSyncCommand(
      { mode: 'auto-greet', dryRun: true },
      { generateGreeting: mockGenerateGreeting },
    )

    // 🚨 绝不能改飞书状态 —— dry-run 必须无副作用
    expect(mockUpdateRecord).not.toHaveBeenCalled()
  })

  it('dry-run 返回 dryRun=true 标记 + 生成的消息列表', async () => {
    mockLoadConfig.mockReturnValue(makeLoadedConfig())
    mockListRecords.mockResolvedValue(DRY_PENDING_RECORDS)

    const { runSyncCommand } = await freshHandler()
    const result = await runSyncCommand(
      { mode: 'auto-greet', dryRun: true },
      { generateGreeting: mockGenerateGreeting },
    )

    if (result.action !== 'auto-greet') throw new Error('unreachable')
    expect(result.dryRun).toBe(true)
    // 应该有 messages 数组（每个 job 一条招呼语）
    expect(result.messages).toBeDefined()
    expect(result.messages).toHaveLength(2)
    expect(result.messages?.[0]).toEqual(
      expect.objectContaining({
        jobId: 'rec_d1',
        message: 'Hi rec_d1, 我对贵岗位很感兴趣',
      }),
    )
    // succeeded/failed 应为 0（dry-run 没真发消息）
    expect(result.succeeded).toBe(0)
    expect(result.failed).toBe(0)
  })

  it('dry-run 输出包含 DRY RUN 横幅 + 每条招呼语', async () => {
    mockLoadConfig.mockReturnValue(makeLoadedConfig())
    mockListRecords.mockResolvedValue(DRY_PENDING_RECORDS)

    const { runSyncCommand } = await freshHandler()
    const result = await runSyncCommand(
      { mode: 'auto-greet', dryRun: true },
      { generateGreeting: mockGenerateGreeting },
    )

    if (result.action !== 'auto-greet') throw new Error('unreachable')
    expect(result.formatted).toContain('DRY RUN')
    expect(result.formatted).toContain('rec_d1')
    expect(result.formatted).toContain('Hi rec_d1')
    expect(result.formatted).toContain('rec_d2')
  })

  it('dry-run 即使 generateGreeting 失败也不调 send（fail-fast 仍然适用）', async () => {
    mockLoadConfig.mockReturnValue(makeLoadedConfig())
    mockListRecords.mockResolvedValue(DRY_PENDING_RECORDS)
    // 第 2 个岗位 LLM 失败
    mockGenerateGreeting
      .mockResolvedValueOnce('msg-1')
      .mockRejectedValueOnce(new Error('LLM rate limit'))

    const { runSyncCommand } = await freshHandler()
    const result = await runSyncCommand(
      { mode: 'auto-greet', dryRun: true },
      { generateGreeting: mockGenerateGreeting },
    )

    if (result.action !== 'auto-greet') throw new Error('unreachable')
    expect(result.dryRun).toBe(true)
    // 只有 1 条消息成功生成
    expect(result.messages).toHaveLength(1)
    expect(result.messages?.[0]?.jobId).toBe('rec_d1')
    // 仍不调 send/update
    expect(mockRunSendCommand).not.toHaveBeenCalled()
    expect(mockUpdateRecord).not.toHaveBeenCalled()
    // 错误要累积（与普通 auto-greet 一致）
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.reason).toMatch(/LLM rate limit/)
  })

  it('dry-run 模式无『待投递』岗位时不报错', async () => {
    mockLoadConfig.mockReturnValue(makeLoadedConfig())
    mockListRecords.mockResolvedValue({
      code: 0,
      msg: 'ok',
      data: {
        items: [{ record_id: 'r1', fields: { 状态: '已沟通' } }],
      },
    })

    const { runSyncCommand } = await freshHandler()
    const result = await runSyncCommand(
      { mode: 'auto-greet', dryRun: true },
      { generateGreeting: mockGenerateGreeting },
    )

    if (result.action !== 'auto-greet') throw new Error('unreachable')
    expect(result.dryRun).toBe(true)
    expect(result.total).toBe(0)
    expect(result.messages).toHaveLength(0)
    expect(mockGenerateGreeting).not.toHaveBeenCalled()
  })
})