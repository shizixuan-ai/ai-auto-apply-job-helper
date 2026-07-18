// ============================================================
// sendGreeting — Sprint 2026-07-14 task #41（ADR-0007 P3 协议）
// ============================================================
// 覆盖 5 条用例，对应探针 P3 实测 + master 限流语义：
//
//   1. happy path: BOSS code=0 + zpData.encBossId → action="sent"
//   2. master 限流语义: chatRemindDialog.content 含 "120 次" → action="sent"
//   3. 探针实测: BOSS code=1011 "当前登录状态已失效" → action="session_expired"
//   4. 其他 BOSS code → action="failed"，error 含 BOSS message
//   5. fetch 异常 → action="failed"，error 含原始 message
//
// Mock 策略：
//   - sendGreeting 内部只调 page.evaluate 1 次（robustEvaluate 包 fetch）
//   - cookie 提取 + fetch 在浏览器上下文**同一次**执行（避免 context 断开）
//   - mockPage.evaluate.mockResolvedValueOnce 直接返 BOSS 响应
//
// TDD 状态：GREEN（按 ADR-0007 P3 探针实测证据写测试）
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { sendGreeting } from './index.js'

// ============================================================
// Fixture：mock page（只 mock 1 次 evaluate）
// ============================================================

function makeMockPage(evaluateResult: unknown) {
  return {
    evaluate: vi.fn().mockResolvedValueOnce(evaluateResult),
    $: vi.fn().mockResolvedValue(null), // withGuard probe → 不命中 selector
  }
}

const SAMPLE_JOB_ID = '89d4f6843ce5961f0nF83dm9FFdR'
const SAMPLE_LID = '1a9ABvRMl3R.search.1'
const SAMPLE_SECURITY_ID = 'esknqGib9UMBo-O1E14211s0Gf2Ocd_ZIETnSCRgff7Gwa55_aQKubwnNTBbv5dFESmNRBbnEklyg9XU9qnXKWZU7mh83vzYltaJZRxqsKcUXEPvR_L0IQpX3J5HJOUldjghxBDbD2E3URXz-PJm7qiBoyrfx7HpRhWRpf2VbfI3snZHqznzMlFxnkzZKwCE7nuoqUxzJQR9THufAothrg~~'

// ============================================================
// 5 个测试（按 ADR-0007 决策）
// ============================================================

describe('sendGreeting — Sprint 2026-07-14 P3 协议 (ADR-0007)', () => {
  // ----------------------------------------------------------
  // TEST 1: happy path — 探针 P3 raw.zpData 实测
  // ----------------------------------------------------------

  it('TEST 1: BOSS code=0 + zpData.encBossId → action="sent"，friendId 解析为 encBossId', async () => {
    // Arrange：探针 P3 raw 响应（来自 tests/fixtures/friend-add-schema.json）
    const mockPage = makeMockPage({
      code: 0,
      message: 'Success',
      zpData: {
        showGreeting: true,
        greeting: '7年Java高并发实战...',
        bossSource: 0,
        securityId: 'esknqGib9UMBo-O1E14211s0Gf2Ocd_Z...',
        source: '',
        encBossId: 'e2043def326cf10d0XN509i-E1s~',
      },
    })

    const result = await sendGreeting(
      mockPage as any,
      SAMPLE_JOB_ID,
      SAMPLE_LID,
      SAMPLE_SECURITY_ID,
    )

    expect(result.action).toBe('sent')
    // ★ 关键：friendId 应解析 zpData.encBossId（不是 friendId / chatId）
    expect(result.friendId).toBe('e2043def326cf10d0XN509i-E1s~')
    // 防"假绿"：page.evaluate 必须被实际调用 1 次（robustEvaluate 包装）
    expect(mockPage.evaluate).toHaveBeenCalledTimes(1)
  })

  // ----------------------------------------------------------
  // TEST 2: master 限流语义 — chatRemindDialog.content 含 "120 次"
  // ----------------------------------------------------------

  it('TEST 2: chatRemindDialog.content 含 "120 位 BOSS" → action="sent"（master 限流算 SUCCESS）', async () => {
    const mockPage = makeMockPage({
      code: 1, // master platform.ts:531 PushResultStatus.FAIL
      message: '今日已达上限',
      zpData: {
        bizData: {
          chatRemindDialog: {
            content: '您今天已与120位BOSS沟通，超出当日限制',
          },
        },
      },
    })

    const result = await sendGreeting(
      mockPage as any,
      SAMPLE_JOB_ID,
      SAMPLE_LID,
      SAMPLE_SECURITY_ID,
    )

    // master 语义：120 次算 SUCCESS（boss 自动开聊）
    expect(result.action).toBe('sent')
    expect(result.error).toMatch(/120位BOSS/)
  })

  // ----------------------------------------------------------
  // TEST 3: 探针实测 — bossCode=1011 → session_expired（新增 action）
  // ----------------------------------------------------------

  it('TEST 3: BOSS code=1011 "当前登录状态已失效" → action="session_expired"', async () => {
    const mockPage = makeMockPage({
      code: 1011,
      message: '当前登录状态已失效',
      zpData: {},
    })

    const result = await sendGreeting(
      mockPage as any,
      SAMPLE_JOB_ID,
      SAMPLE_LID,
      SAMPLE_SECURITY_ID,
    )

    // Sprint 2026-07-14 新增：bossCode=1011 区分于 security_blocked
    expect(result.action).toBe('session_expired')
    expect(result.error).toMatch(/登录状态已失效/)
  })

  // ----------------------------------------------------------
  // TEST 4: 其他 BOSS code → failed
  // ----------------------------------------------------------

  it('TEST 4: BOSS 其他 code（如岗位下架）→ action="failed"，error 含 BOSS message', async () => {
    const mockPage = makeMockPage({
      code: 99999999,
      message: '岗位已下架',
      zpData: {},
    })

    const result = await sendGreeting(
      mockPage as any,
      SAMPLE_JOB_ID,
      SAMPLE_LID,
      SAMPLE_SECURITY_ID,
    )

    expect(result.action).toBe('failed')
    // 关键：原始 BOSS message 必须保留到 error（用户调试依据）
    expect(result.error).toMatch(/岗位已下架/)
  })

  // ----------------------------------------------------------
  // TEST 5: fetch 异常 → failed
  // ----------------------------------------------------------

  it('TEST 5: fetch 抛异常（如 Cookie 缺失 / Network error）→ action="failed"，error 含原始 message', async () => {
    // mock evaluate 返 rejected promise（模拟 fetch 抛错）
    const mockPage = {
      evaluate: vi.fn().mockRejectedValueOnce(new Error('Network error')),
      $: vi.fn().mockResolvedValue(null),
    }

    const result = await sendGreeting(
      mockPage as any,
      SAMPLE_JOB_ID,
      SAMPLE_LID,
      SAMPLE_SECURITY_ID,
    )

    expect(result.action).toBe('failed')
    expect(result.error).toMatch(/Network error/)
  })
})