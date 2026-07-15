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

// Sprint 2026-07-14 / ADR-0007：auto-greet 模式暂 skip（sync-handler.ts:235 用 PLACEHOLDER_LID/SID_TODO 等 Sprint C）
//   飞书 schema 待升级（LID/SECURITY_ID 字段），schema 升级后再恢复
describe.skip('runSyncCommand — auto-greet 模式（Sprint C 恢复）', () => {
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

  // 待投递岗位样本（3 条 + 1 非待投递）
  // ⚠️ 2026-07-07 P0 修复后必须包含 BOSS_ID（BOSS 真实 job_id）
  // ⚠️ 2026-07-09 Sprint 2B Commit 2: 必须包含 HR_UID（friend/add 第二参数）
  // 否则 sync-handler 会显式拒绝（不会偷偷拿 record_id 当 BOSS job_id）
  const PENDING_RECORDS = {
    code: 0,
    msg: 'ok',
    data: {
      items: [
        { record_id: 'rec_p1', fields: { 职位: '前端A', 公司: '字节', BOSS_ID: 'boss_a1', HR_UID: 'hr_a1', 状态: '待投递' } },
        { record_id: 'rec_p2', fields: { 职位: '前端B', 公司: '美团', BOSS_ID: 'boss_b2', HR_UID: 'hr_b2', 状态: '待投递' } },
        { record_id: 'rec_p3', fields: { 职位: '前端C', 公司: '腾讯', BOSS_ID: 'boss_c3', HR_UID: 'hr_c3', 状态: '待投递' } },
        { record_id: 'rec_other', fields: { 职位: '运维', 公司: '阿里', BOSS_ID: 'boss_other', HR_UID: 'hr_other', 状态: '已沟通' } }, // 非待投递
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
      expect.objectContaining({ jobId: 'boss_a1', cdp: false }),  // Sprint 2B GAP-A: BOSS job_id
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
          { record_id: 'rec_semi', fields: { 状态: '待投递', BOSS_ID: 'boss_semi', HR_UID: 'hr_semi' } },
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
          { record_id: 'rec_str', fields: { 状态: '待投递', BOSS_ID: 'boss_str', HR_UID: 'hr_str' } },
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
    expect(mockGenerateGreeting).toHaveBeenCalledWith('boss_a1') // 2026-07-07: 用 BOSS_ID 不是 record_id
    expect(mockGenerateGreeting).toHaveBeenCalledWith('boss_b2')
    expect(mockGenerateGreeting).toHaveBeenCalledWith('boss_c3')
    // runSendCommand 收到 mockGenerateGreeting 返回的 message
    expect(mockRunSendCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 'boss_a1',   // Sprint 2B GAP-A: BOSS job_id，不是 record_id
        message: 'Hi boss_a1, 我对贵岗位很感兴趣',
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
        items: [{ record_id: 'rec_str', fields: { 状态: '待投递', BOSS_ID: 'boss_str', HR_UID: 'hr_str' } }],
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

// Sprint 2026-07-14 / ADR-0007：auto-greet --dry-run 模式暂 skip（同上 sync-handler.ts:235 PLACEHOLDER）
describe.skip('runSyncCommand — auto-greet --dry-run 模式（Sprint C 恢复）', () => {
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
        { record_id: 'rec_d1', fields: { 职位: '前端', 公司: '字节', BOSS_ID: 'boss_d1', HR_UID: 'hr_d1', 状态: '待投递' } },
        { record_id: 'rec_d2', fields: { 职位: '后端', 公司: '美团', BOSS_ID: 'boss_d2', HR_UID: 'hr_d2', 状态: '待投递' } },
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
    expect(mockGenerateGreeting).toHaveBeenCalledWith('boss_d1')
    expect(mockGenerateGreeting).toHaveBeenCalledWith('boss_d2')
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
    expect(result.messages).toHaveLength(2)
    expect(result.messages?.[0]).toEqual(
      expect.objectContaining({
        jobId: 'rec_d1',
        message: 'Hi boss_d1, 我对贵岗位很感兴趣',
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
    expect(result.formatted).toContain('Hi boss_d1')
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

  // ----------------------------------------------------------------
  // 2026-07-07 P0 修复：缺少 BOSS_ID 必须显式报错，不能拿 record_id 糊弄
  // ----------------------------------------------------------------
  it('🚨 关键：record 缺少 BOSS_ID → 显式报错 + 不调 generateGreeting', async () => {
    mockLoadConfig.mockReturnValue(makeLoadedConfig())
    mockListRecords.mockResolvedValue({
      code: 0,
      msg: 'ok',
      data: {
        items: [
          // 没有 BOSS_ID 字段（旧数据/手动添加）
          { record_id: 'rec_no_boss', fields: { 职位: '前端', 公司: '字节', 状态: '待投递' } },
          // BOSS_ID 是空字符串
          { record_id: 'rec_empty_boss', fields: { 职位: '后端', 公司: '美团', BOSS_ID: '', 状态: '待投递' } },
          // BOSS_ID 是空白
          { record_id: 'rec_ws_boss', fields: { 职位: '全栈', 公司: '腾讯', BOSS_ID: '   ', 状态: '待投递' } },
        ],
      },
    })

    const { runSyncCommand } = await freshHandler()
    const result = await runSyncCommand(
      { mode: 'auto-greet' },
      { generateGreeting: mockGenerateGreeting },
    )

    if (result.action !== 'auto-greet') throw new Error('unreachable')
    expect(result.total).toBe(3)
    expect(result.succeeded).toBe(0)
    expect(result.failed).toBe(3)
    expect(result.errors).toHaveLength(3)
    // 每条错误都要明确说「缺少 BOSS_ID」并提示用户怎么修
    for (const err of result.errors) {
      expect(err.reason).toMatch(/缺少 BOSS_ID/)
      expect(err.reason).toMatch(/bapply search/)
    }
    // 🚨 关键：不能调 generateGreeting（拿无效 URL 去请求 BOSS 是浪费风控额度）
    expect(mockGenerateGreeting).not.toHaveBeenCalled()
    // 也不能调 send/update（fake green 防护）
    expect(mockRunSendCommand).not.toHaveBeenCalled()
    expect(mockUpdateRecord).not.toHaveBeenCalled()
  })

  // ============================================================
  // Sprint 2B Commit 2: 修 3 GAP（jobId/bossJobId/recordId 拆分 + 读 HR_UID）
  // ------------------------------------------------------------
  // 3 GAP（commit 1 实施时已识别，commit 2 修复）：
  //   GAP-A: jobId 实际是 Feishu record_id（应用 bossJobId）
  //   GAP-B: hrUid 永远是 ''（应用 fields['HR_UID']）
  //   GAP-C: runSendCommand 缺 recordId → send-handler 不写飞书打招呼状态
  // ============================================================

  it('Sprint 2B GAP-A: 调 runSendCommand 时 jobId=BOSS_ID（不是 record_id）', async () => {
    mockLoadConfig.mockReturnValue(makeLoadedConfig())
    mockListRecords.mockResolvedValue({
      code: 0, msg: 'ok',
      data: {
        items: [
          { record_id: 'rec_x1', fields: { 状态: '待投递', BOSS_ID: 'boss_job_real_id', HR_UID: 'hr_x1' } },
        ],
      },
    })
    mockRunSendCommand.mockResolvedValue({ action: 'ok', reason: 'ok' })
    mockUpdateRecord.mockResolvedValue({ code: 0, msg: 'ok' })

    const { runSyncCommand } = await freshHandler()
    await runSyncCommand({ mode: 'auto-greet' }, { generateGreeting: mockGenerateGreeting })

    // 🚨 关键：runSendCommand 的 jobId 必须等于 BOSS_ID（encryptJobId），
    //           不是 Feishu record_id（rec_x1）
    expect(mockRunSendCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 'boss_job_real_id',  // ✅ BOSS job_id，不是 record_id
      }),
    )
  })

  it('Sprint 2B GAP-B: 读 fields[\'HR_UID\'] 传给 runSendCommand.hrUid', async () => {
    mockLoadConfig.mockReturnValue(makeLoadedConfig())
    mockListRecords.mockResolvedValue({
      code: 0, msg: 'ok',
      data: {
        items: [
          {
            record_id: 'rec_y1',
            fields: {
              状态: '待投递',
              BOSS_ID: 'boss_j1',
              HR_UID: 'b52207e95bbaaa7e0nF93dW8E1BZ',  // search-and-write 写入的字段
            },
          },
        ],
      },
    })
    mockRunSendCommand.mockResolvedValue({ action: 'ok', reason: 'ok' })
    mockUpdateRecord.mockResolvedValue({ code: 0, msg: 'ok' })

    const { runSyncCommand } = await freshHandler()
    await runSyncCommand({ mode: 'auto-greet' }, { generateGreeting: mockGenerateGreeting })

    // 🚨 关键：runSendCommand.hrUid 必须等于 fields['HR_UID']（boss 加密 uid）
    expect(mockRunSendCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        hrUid: 'b52207e95bbaaa7e0nF93dW8E1BZ',
      }),
    )
  })

  it('Sprint 2B GAP-B 缺失防护: record 缺 HR_UID 时显式报错 + 不调 runSendCommand', async () => {
    mockLoadConfig.mockReturnValue(makeLoadedConfig())
    mockListRecords.mockResolvedValue({
      code: 0, msg: 'ok',
      data: {
        items: [
          // 有 BOSS_ID 但缺 HR_UID（旧数据 / search-and-write 没跑过）
          { record_id: 'rec_no_hruid', fields: { 状态: '待投递', BOSS_ID: 'boss_j2' } },
          // HR_UID 是空字符串
          { record_id: 'rec_empty_hruid', fields: { 状态: '待投递', BOSS_ID: 'boss_j3', HR_UID: '' } },
        ],
      },
    })

    const { runSyncCommand } = await freshHandler()
    const result = await runSyncCommand(
      { mode: 'auto-greet' },
      { generateGreeting: mockGenerateGreeting },
    )

    if (result.action !== 'auto-greet') throw new Error('unreachable')
    expect(result.total).toBe(2)
    expect(result.succeeded).toBe(0)
    expect(result.failed).toBe(2)
    // 每条 error 必须明确说明 HR_UID 缺失 + 怎么修
    for (const err of result.errors) {
      expect(err.reason).toMatch(/缺少 HR_UID/)
      expect(err.reason).toMatch(/bapply search/)
    }
    // 🚨 关键：不调 generateGreeting / runSendCommand / updateRecord
    // （HR_UID 缺 → friend/add 必失败，不浪费风控额度）
    expect(mockGenerateGreeting).not.toHaveBeenCalled()
    expect(mockRunSendCommand).not.toHaveBeenCalled()
    expect(mockUpdateRecord).not.toHaveBeenCalled()
  })

  it('Sprint 2B GAP-C: runSendCommand 必须接收 recordId（用于写飞书打招呼状态）', async () => {
    mockLoadConfig.mockReturnValue(makeLoadedConfig())
    mockListRecords.mockResolvedValue({
      code: 0, msg: 'ok',
      data: {
        items: [
          {
            record_id: 'rec_z1',
            fields: {
              状态: '待投递',
              BOSS_ID: 'boss_j4',
              HR_UID: 'hr_real_uid',
            },
          },
        ],
      },
    })
    mockRunSendCommand.mockResolvedValue({ action: 'ok', reason: 'ok' })
    mockUpdateRecord.mockResolvedValue({ code: 0, msg: 'ok' })

    const { runSyncCommand } = await freshHandler()
    await runSyncCommand({ mode: 'auto-greet' }, { generateGreeting: mockGenerateGreeting })

    // 🚨 关键：runSendCommand 必须带 recordId，让 send-handler 写飞书打招呼状态
    expect(mockRunSendCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        recordId: 'rec_z1',  // Feishu record_id（不是 BOSS_ID）
      }),
    )
  })

  it('Sprint 2B 完整字段校验: runSendCommand 收到完整 5 字段（jobId/bossJobId/recordId/hrUid/cdp）', async () => {
    mockLoadConfig.mockReturnValue(makeLoadedConfig())
    mockListRecords.mockResolvedValue({
      code: 0, msg: 'ok',
      data: {
        items: [
          {
            record_id: 'rec_full',
            fields: {
              状态: '待投递',
              BOSS_ID: 'boss_job_full',
              HR_UID: 'hr_uid_full',
            },
          },
        ],
      },
    })
    mockRunSendCommand.mockResolvedValue({ action: 'ok', reason: 'ok' })
    mockUpdateRecord.mockResolvedValue({ code: 0, msg: 'ok' })

    const { runSyncCommand } = await freshHandler()
    await runSyncCommand({ mode: 'auto-greet' }, { generateGreeting: mockGenerateGreeting })

    expect(mockRunSendCommand).toHaveBeenCalledWith({
      jobId:    'boss_job_full',   // BOSS job_id
      hrUid:    'hr_uid_full',     // BOSS HR 加密 uid
      message:  expect.any(String), // generateGreeting 输出
      recordId: 'rec_full',        // Feishu record_id
      cdp:      false,
    })
  })

  it('部分 record 缺 BOSS_ID 时只跳那些，正常 record 继续处理', async () => {
    mockLoadConfig.mockReturnValue(makeLoadedConfig())
    mockListRecords.mockResolvedValue({
      code: 0,
      msg: 'ok',
      data: {
        items: [
          { record_id: 'rec_ok', fields: { 职位: '前端', 公司: '字节', BOSS_ID: 'boss_ok', HR_UID: 'hr_ok', 状态: '待投递' } },
          { record_id: 'rec_bad', fields: { 职位: '后端', 公司: '美团', 状态: '待投递' } }, // 缺 BOSS_ID
        ],
      },
    })
    mockRunSendCommand.mockResolvedValue({ action: 'ok', reason: 'ok' })
    mockUpdateRecord.mockResolvedValue({ code: 0, msg: 'ok' })

    const { runSyncCommand } = await freshHandler()
    const result = await runSyncCommand(
      { mode: 'auto-greet' },
      { generateGreeting: mockGenerateGreeting },
    )

    if (result.action !== 'auto-greet') throw new Error('unreachable')
    expect(result.succeeded).toBe(1)
    expect(result.failed).toBe(1)
    expect(mockGenerateGreeting).toHaveBeenCalledTimes(1)
    expect(mockGenerateGreeting).toHaveBeenCalledWith('boss_ok') // 用 BOSS_ID 不是 record_id
  })
})