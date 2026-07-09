// ============================================================
// sendGreeting — Sprint 2A RED 测试（friend/add 第一步）
// ============================================================
// 覆盖 5 条 RED 用例，对应 §3.5 流程图 4 的 5 个结局：
//
//   1. happy path: BOSS code=0 → action="sent"，friendId/chatId 解析
//   2. message 长度 > 200 → action="failed"，不发起 HTTP 请求（前置守卫）
//   3. 风控: BOSS code=99991603 → action="security_blocked"
//   4. 限速: BOSS code=99991604 → action="rate_limited"
//   5. 其他 BOSS 错误: 非 0 code → action="failed"，error 含 BOSS message
//
// TDD 状态：RED（friend/add API 实现未到位，期望测试失败）
//
// Mock 策略：
//   - mockPage.evaluate 是唯一被调用的 HTTP 出口
//   - 不调真实 Chrome / 真实 BOSS
//   - 当前 sendGreeting 是 DOM-based（page.goto chat + typeText + click）
//     → 必然抛错 → 全部测试 RED
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { sendGreeting } from './index.js'

// ============================================================
// 预期接口（GREEN 后会从 src/browser/index.ts export 出来）
// ============================================================

interface SendGreetingResult {
  action: 'sent' | 'failed' | 'rate_limited' | 'security_blocked'
  friendId?: string
  chatId?: string
  error?: string
}

// ============================================================
// Fixture：mock page
// ------------------------------------------------------------
// 至少需要：
//   - evaluate: sendGreeting 内部 page.evaluate(fetch friend/add) 用
//   - $:        withGuard → probeRiskSignals → probeGroup 会调 page.$
//               不命中任何 selector（返 null）→ 不会误触发风控
// ============================================================

function makeMockPage() {
  return {
    evaluate: vi.fn(),
    $: vi.fn().mockResolvedValue(null),
  }
}

// ============================================================
// 5 个 RED 测试
// ============================================================

describe('sendGreeting — Sprint 2A friend/add 协议', () => {
  let mockPage: ReturnType<typeof makeMockPage>

  beforeEach(() => {
    mockPage = makeMockPage()
  })

  // ----------------------------------------------------------
  // TEST 1: happy path
  // ----------------------------------------------------------

  it('TEST 1: BOSS code=0 + zpData.status=success → action="sent"，friendId/chatId 解析', async () => {
    // Arrange
    mockPage.evaluate.mockResolvedValueOnce({
      code: 0,
      message: 'ok',
      zpData: {
        status: 'success',
        friendId: 'friend_abc123',
        chatId: 'chat_xyz789',
      },
    })

    // Act
    const result = await sendGreeting(
      mockPage as any,
      'job_enc_7',
      'hr_enc_99',
      '你好，我对贵公司该岗位很感兴趣',
    )

    // Assert
    expect(result.action).toBe('sent')
    expect(result.friendId).toBe('friend_abc123')
    expect(result.chatId).toBe('chat_xyz789')
    // 防"假绿"：必须确认 page.evaluate 被实际调用（不是硬编码返回）
    expect(mockPage.evaluate).toHaveBeenCalledTimes(1)
  })

  // ----------------------------------------------------------
  // TEST 2: length 校验（前置守卫，不发起 HTTP）
  // ----------------------------------------------------------

  it('TEST 2: message 长度 > 200 → action="failed"，不发起 HTTP 请求', async () => {
    // Arrange
    const longMsg = 'a'.repeat(201) // 201 字符，触发超过 MESSAGE_MAX=200

    // Act
    const result = await sendGreeting(
      mockPage as any,
      'job_enc_7',
      'hr_enc_99',
      longMsg,
    )

    // Assert
    expect(result.action).toBe('failed')
    expect(result.error).toMatch(/长度|200|过长/)
    // 关键：长度校验必须在 HTTP 调用之前（防"发了再被 BOSS 拒绝"）
    expect(mockPage.evaluate).not.toHaveBeenCalled()
  })

  // ----------------------------------------------------------
  // TEST 3: 风控
  // ----------------------------------------------------------

  it('TEST 3: BOSS code=99991603（verify required）→ action="security_blocked"', async () => {
    // Arrange
    mockPage.evaluate.mockResolvedValueOnce({
      code: 99991603,
      message: 'verify required',
    })

    // Act
    const result = await sendGreeting(
      mockPage as any,
      'job_enc_7',
      'hr_enc_99',
      '你好',
    )

    // Assert
    expect(result.action).toBe('security_blocked')
    expect(mockPage.evaluate).toHaveBeenCalledTimes(1)
  })

  // ----------------------------------------------------------
  // TEST 4: 限速
  // ----------------------------------------------------------

  it('TEST 4: BOSS code=99991604（too many requests）→ action="rate_limited"', async () => {
    // Arrange
    mockPage.evaluate.mockResolvedValueOnce({
      code: 99991604,
      message: 'too many requests today',
    })

    // Act
    const result = await sendGreeting(
      mockPage as any,
      'job_enc_7',
      'hr_enc_99',
      '你好',
    )

    // Assert
    expect(result.action).toBe('rate_limited')
    expect(mockPage.evaluate).toHaveBeenCalledTimes(1)
  })

  // ----------------------------------------------------------
  // TEST 5: 其他 BOSS 错误
  // ----------------------------------------------------------

  it('TEST 5: BOSS 其他非 0 code（如岗位下架）→ action="failed"，error 含 BOSS message', async () => {
    // Arrange
    mockPage.evaluate.mockResolvedValueOnce({
      code: 99999999,
      message: '岗位已下架',
    })

    // Act
    const result = await sendGreeting(
      mockPage as any,
      'job_enc_7',
      'hr_enc_99',
      '你好',
    )

    // Assert
    expect(result.action).toBe('failed')
    // 关键：原始 BOSS message 必须保留到 error（用户调试依据）
    expect(result.error).toMatch(/岗位已下架/)
  })
})