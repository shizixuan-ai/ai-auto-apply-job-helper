// ============================================================
// `bapply send` 子命令 handler — TDD 测试（RED 阶段）
// ============================================================
// 覆盖 P0 audit 修复：CLI send command 在 GuardError 抛出时
// 必须输出友好 reason + 选对 exit code，禁止 unhandled rejection。
//
// handler 签名（待 GREEN 实现）：
//   runSendCommand(opts, deps) → Promise<SendCommandResult>
//
//   SendCommandResult = { action, reason }
//     - 'ok'           → exit 0
//     - 'failed'       → exit 1
//     - 'invalid_args' → exit 2
//     - 'abort_today'  → exit 3  ← 风控触发的关键 signal
//     - 'abort'        → exit 4
// ============================================================

import { describe, it, expect, vi } from 'vitest'
import { GuardError } from '../../browser/guard.js'

// ------------------------------------------------------------
// Test helpers
// ------------------------------------------------------------

function makeDeps(overrides: Partial<{
  sendGreeting: any
  createSession: any
  closeSession: any
  writeGreetingStatus: any
}> = {}) {
  const sendGreeting = overrides.sendGreeting ?? vi.fn().mockResolvedValue({ action: 'sent', friendId: 'f_default' })
  const session = {
    page: { mockPage: true },
    browser: { close: vi.fn().mockResolvedValue(undefined) },
    context: undefined,
    cdpMode: true as const,
  }
  const createSession =
    overrides.createSession ?? vi.fn().mockResolvedValue(session)
  const closeSession =
    overrides.closeSession ?? vi.fn().mockResolvedValue(undefined)
  const writeGreetingStatus =
    overrides.writeGreetingStatus ?? vi.fn().mockResolvedValue(undefined)
  return { sendGreeting, createSession, closeSession, writeGreetingStatus }
}

function makeGuardDecision(action: 'abort_today' | 'abort', reason: string) {
  return {
    action,
    reason,
    signal: {
      type: 'rate_limit' as const,
      confidence: 1,
      rawSelector: '.rate-a',
      detectedAt: new Date('2026-07-04T00:00:00Z'),
    },
  }
}

// ============================================================
// TDD: 测试先行（RED）
// ============================================================

describe('runSendCommand — P0 fix: CLI catch GuardError', () => {
  it('happy path: sendGreeting 返 {action:"sent"} → action="ok", reason 含 "成功"', async () => {
    const deps = makeDeps({
      sendGreeting: vi.fn().mockResolvedValue({ action: 'sent', friendId: 'f1' }),
    })
    const { runSendCommand } = await import('./send-handler.js')

    const result = await runSendCommand(
      { jobId: 'j1', hrUid: 'hr_test', message: '你好' },
      deps,
    )

    expect(result.action).toBe('ok')
    expect(result.reason).toMatch(/成功/)
    // Sprint 2A.2: 4 参数签名（hrUid 来自 opts）
    expect(deps.sendGreeting).toHaveBeenCalledWith(
      { mockPage: true },
      'j1',
      'hr_test',
      '你好',
    )
  })

  it('缺 message → action="invalid_args" 且不调 sendGreeting', async () => {
    const deps = makeDeps()
    const { runSendCommand } = await import('./send-handler.js')

    const result = await runSendCommand({ jobId: 'j1', hrUid: 'hr_test' }, deps)

    expect(result.action).toBe('invalid_args')
    expect(result.reason).toMatch(/请通过 -m/)
    expect(deps.sendGreeting).not.toHaveBeenCalled()
    // invalid_args 也不该创建 session
    expect(deps.createSession).not.toHaveBeenCalled()
  })

  it('Sprint 2A.2: 缺 hrUid → action="invalid_args" 且不调 sendGreeting', async () => {
    const deps = makeDeps()
    const { runSendCommand } = await import('./send-handler.js')

    // cast: 故意省略 hrUid 以触发 invalid_args
    const result = await runSendCommand(
      { jobId: 'j1', message: 'hi' } as any,
      deps,
    )

    expect(result.action).toBe('invalid_args')
    expect(result.reason).toMatch(/-u/)
    expect(deps.sendGreeting).not.toHaveBeenCalled()
    expect(deps.createSession).not.toHaveBeenCalled()
  })

  it('P0 修复核心: GuardError(abort_today) 抛出 → action="abort_today", reason 来自 decision', async () => {
    const decision = makeGuardDecision('abort_today', '今日已达上限（.rate-a）。今日任务停止。')
    const deps = makeDeps({
      sendGreeting: vi.fn().mockRejectedValue(new GuardError(decision)),
    })
    const { runSendCommand } = await import('./send-handler.js')

    const result = await runSendCommand(
      { jobId: 'j1', hrUid: 'hr_test', message: 'hi' },
      deps,
    )

    expect(result.action).toBe('abort_today')
    expect(result.reason).toMatch(/已达上限/)
    // 关键：不能 unhandled rejection 抛到调用方（这正是 P0 修复目标）
  })

  it('GuardError(abort) 抛出 → action="abort", reason 来自 decision', async () => {
    const decision = makeGuardDecision('abort', '检测到不可恢复阻断（.captcha）')
    const deps = makeDeps({
      sendGreeting: vi.fn().mockRejectedValue(new GuardError(decision)),
    })
    const { runSendCommand } = await import('./send-handler.js')

    const result = await runSendCommand(
      { jobId: 'j1', hrUid: 'hr_test', message: 'hi' },
      deps,
    )

    expect(result.action).toBe('abort')
    expect(result.reason).toMatch(/不可恢复/)
  })

  it('sendGreeting 返 {action:"failed"}（业务失败）→ action="failed"', async () => {
    const deps = makeDeps({
      sendGreeting: vi.fn().mockResolvedValue({ action: 'failed', error: 'BOSS 拒绝' }),
    })
    const { runSendCommand } = await import('./send-handler.js')

    const result = await runSendCommand(
      { jobId: 'j1', hrUid: 'hr_test', message: 'hi' },
      deps,
    )

    expect(result.action).toBe('failed')
    expect(result.reason).toMatch(/失败/)
    expect(result.reason).toMatch(/BOSS 拒绝/)
  })

  it('sendGreeting 抛普通 Error（非 GuardError）→ action="failed", reason 含原始 message', async () => {
    const deps = makeDeps({
      sendGreeting: vi.fn().mockRejectedValue(new Error('navigation timeout')),
    })
    const { runSendCommand } = await import('./send-handler.js')

    const result = await runSendCommand(
      { jobId: 'j1', hrUid: 'hr_test', message: 'hi' },
      deps,
    )

    expect(result.action).toBe('failed')
    expect(result.reason).toMatch(/navigation timeout/)
  })

  it('成功路径: closeSession 在 finally 调用（即使 ok 也清理浏览器）', async () => {
    const deps = makeDeps({
      sendGreeting: vi.fn().mockResolvedValue({ action: 'sent' }),
    })
    const { runSendCommand } = await import('./send-handler.js')

    await runSendCommand({ jobId: 'j1', hrUid: 'hr_test', message: 'hi' }, deps)

    expect(deps.closeSession).toHaveBeenCalledTimes(1)
  })

  it('GuardError 抛出时 closeSession 仍被调用（finally 清理）', async () => {
    const decision = makeGuardDecision('abort_today', '上限')
    const deps = makeDeps({
      sendGreeting: vi.fn().mockRejectedValue(new GuardError(decision)),
    })
    const { runSendCommand } = await import('./send-handler.js')

    await runSendCommand({ jobId: 'j1', hrUid: 'hr_test', message: 'hi' }, deps)

    // 关键：即使 GuardError 抛出，session 必须清理（防 Chrome 泄漏）
    expect(deps.closeSession).toHaveBeenCalledTimes(1)
  })

  it('cdp=true 时 cdp flag 透传给 createSession', async () => {
    const deps = makeDeps()
    const { runSendCommand } = await import('./send-handler.js')

    await runSendCommand({ jobId: 'j1', hrUid: 'hr_test', message: 'hi', cdp: true }, deps)

    expect(deps.createSession).toHaveBeenCalledWith(true)
  })

  it('cdp 缺省时默认 false（stealth launch 兜底）', async () => {
    const deps = makeDeps()
    const { runSendCommand } = await import('./send-handler.js')

    await runSendCommand({ jobId: 'j1', hrUid: 'hr_test', message: 'hi' }, deps)

    expect(deps.createSession).toHaveBeenCalledWith(false)
  })
})

// ============================================================
// Sprint 2A.2: Feishu writeback 测试（3 个新测试）
// ============================================================

describe('runSendCommand — Sprint 2A.2: Feishu writeback', () => {
  it('有 recordId + sendGreeting sent → writeGreetingStatus 被调，参数含 (recordId, "sent", any timestamp)', async () => {
    const deps = makeDeps({
      sendGreeting: vi.fn().mockResolvedValue({ action: 'sent', friendId: 'f_1' }),
      writeGreetingStatus: vi.fn().mockResolvedValue(undefined),
    })
    const { runSendCommand } = await import('./send-handler.js')

    const result = await runSendCommand(
      { jobId: 'j1', hrUid: 'hr_test', message: 'hi', recordId: 'rec_001' },
      deps,
    )

    expect(result.action).toBe('ok')
    expect(result.reason).toMatch(/飞书已更新/)
    expect(deps.writeGreetingStatus).toHaveBeenCalledTimes(1)
    expect(deps.writeGreetingStatus).toHaveBeenCalledWith(
      'rec_001',
      'sent',
      expect.any(Number),
    )
  })

  it('有 recordId + sendGreeting failed → writeGreetingStatus 被调，参数含 (recordId, "failed", any timestamp)', async () => {
    const deps = makeDeps({
      sendGreeting: vi.fn().mockResolvedValue({ action: 'failed', error: 'BOSS 拒绝' }),
      writeGreetingStatus: vi.fn().mockResolvedValue(undefined),
    })
    const { runSendCommand } = await import('./send-handler.js')

    const result = await runSendCommand(
      { jobId: 'j1', hrUid: 'hr_test', message: 'hi', recordId: 'rec_002' },
      deps,
    )

    expect(result.action).toBe('failed')
    expect(result.reason).toMatch(/飞书已更新/)
    expect(deps.writeGreetingStatus).toHaveBeenCalledWith(
      'rec_002',
      'failed',
      expect.any(Number),
    )
  })

  it('无 recordId → writeGreetingStatus 不被调', async () => {
    const deps = makeDeps({
      sendGreeting: vi.fn().mockResolvedValue({ action: 'sent' }),
      writeGreetingStatus: vi.fn().mockResolvedValue(undefined),
    })
    const { runSendCommand } = await import('./send-handler.js')

    await runSendCommand(
      { jobId: 'j1', hrUid: 'hr_test', message: 'hi' },
      deps,
    )

    expect(deps.writeGreetingStatus).not.toHaveBeenCalled()
  })

  it('writeGreetingStatus 抛错 → send 主流程不阻塞，result.reason 标注失败', async () => {
    const deps = makeDeps({
      sendGreeting: vi.fn().mockResolvedValue({ action: 'sent', friendId: 'f_1' }),
      writeGreetingStatus: vi.fn().mockRejectedValue(new Error('飞书 API 限流')),
    })
    const { runSendCommand } = await import('./send-handler.js')

    const result = await runSendCommand(
      { jobId: 'j1', hrUid: 'hr_test', message: 'hi', recordId: 'rec_003' },
      deps,
    )

    // 主流程仍返回 ok（sendGreeting 成功），飞书写入失败仅在 reason 标注
    expect(result.action).toBe('ok')
    expect(result.reason).toMatch(/飞书写入失败/)
    expect(result.reason).toMatch(/飞书 API 限流/)
  })

  it('GuardError(abort_today) 时 writeGreetingStatus 不被调（未真发打招呼）', async () => {
    const decision = makeGuardDecision('abort_today', '今日上限')
    const deps = makeDeps({
      sendGreeting: vi.fn().mockRejectedValue(new GuardError(decision)),
      writeGreetingStatus: vi.fn().mockResolvedValue(undefined),
    })
    const { runSendCommand } = await import('./send-handler.js')

    const result = await runSendCommand(
      { jobId: 'j1', hrUid: 'hr_test', message: 'hi', recordId: 'rec_004' },
      deps,
    )

    expect(result.action).toBe('abort_today')
    // 风控时未真发，不应写飞书
    expect(deps.writeGreetingStatus).not.toHaveBeenCalled()
  })
})