// ============================================================
// tests/unit/auto/guard.test.ts — Sprint C-2b §14.5 RED
// ------------------------------------------------------------
// 覆盖: T17-T18 (per ADR-0016 §14.5 C-2b + R2 风控墙)
// 纪律: §3.13 错误分层 (GuardError.layer='GUARD');
//       §3.12 mock 注入 (notifier stub)
// 单账号红线守住: 仅 unit test, 不触碰 BOSS
// ============================================================

import { describe, it, expect } from 'vitest'
import {
  GuardError,
  isGuardError,
  type GuardReason,
} from '../../../src/auto/guard'
import { runDailyLoop, type AutoHandlerDeps } from '../../../src/cli/handlers/auto-handler'
import { createInMemoryCounterStore } from '../../../src/auto/counter-store'
import type { AccountMeta, AutoConfig } from '../../../src/auto/throttle'

// ─── T17: GuardError class + isGuardError type guard ─────────

describe('T17: GuardError + isGuardError', () => {
  it('T17a: GuardError 实例化携带 layer="GUARD" + reason + name', () => {
    const e = new GuardError('环境异常', 'anti_bot')

    expect(e).toBeInstanceOf(Error)
    expect(e).toBeInstanceOf(GuardError)
    expect(e.name).toBe('GuardError')
    expect(e.layer).toBe('GUARD')  // per §3.13
    expect(e.reason).toBe('anti_bot')
    expect(e.message).toBe('环境异常')
  })

  it('T17b: isGuardError 正确区分 GuardError / ThrottleError / 普通 Error', () => {
    const guard = new GuardError('反爬触发', 'ip_block')
    const plain = new Error('普通错误')
    const thrown = '字符串错误'  // 异常可能 throw 字符串

    expect(isGuardError(guard)).toBe(true)
    expect(isGuardError(plain)).toBe(false)
    expect(isGuardError(thrown)).toBe(false)
    expect(isGuardError(null)).toBe(false)
    expect(isGuardError(undefined)).toBe(false)
  })

  it('T17c: GuardReason 三种类型合法 (anti_bot / rate_limit / ip_block)', () => {
    const reasons: GuardReason[] = ['anti_bot', 'rate_limit', 'ip_block']
    for (const reason of reasons) {
      const e = new GuardError(`${reason} 触发`, reason)
      expect(e.reason).toBe(reason)
      expect(isGuardError(e)).toBe(true)
    }
  })

  it('T17d: throw GuardError 携带 cause 链 (per §3.13)', () => {
    const original = new Error('BOSS 401 response')
    const guarded = new GuardError('反爬触发', 'anti_bot', { cause: original })

    expect(guarded.cause).toBe(original)
    expect((guarded.cause as Error).message).toBe('BOSS 401 response')
  })
})

// ─── T18: auto-handler 集成 GuardError → blocked + exit 2 ───

describe('T18: auto-handler 捕获 GuardError', () => {
  it('T18a: sendGreeting 抛 GuardError → blocked + exit 2 + notifier critical + state=blocked', async () => {
    const metaDay15: AccountMeta = {
      registeredAt: Date.now() - 15 * 86_400_000,
      accountAgeDays: 15,
      baseDailyCap: 30,
      targetDailyCap: 100,
      weeklyCap: 500,
      warmupSchedule: [
        { dayStart: 1, cap: 50 },
        { dayStart: 8, cap: 70 },
        { dayStart: 15, cap: 100 },
      ],
    }
    const baseConfig: AutoConfig = {
      dryRun: false,
      phase: 'morning',
      quota: { morning: 5, afternoon: 5, weekly_cap: 50 },
      throttle: {
        morning_interval_ms: [0, 1],
        afternoon_interval_ms: [0, 1],
        jitter_pct: 0,
        long_pause: { every_n_jobs: 100, duration_ms: [0, 1] },
        afternoon_mid_break: { after_job: 100, duration_ms: [0, 1] },
      },
    }
    const fiveJobs = Array.from({ length: 5 }, (_, i) => ({ id: `j${i + 1}` }))

    const notifyCalls: Array<{ level: 'warn' | 'critical'; msg: string }> = []
    const deps: AutoHandlerDeps = {
      now: () => new Date('2026-07-28T09:10:00').getTime(),
      rand: () => 0.5,
      bossSearch: async () => fiveJobs,
      counterStore: createInMemoryCounterStore(),
      sendGreeting: async (job) => {
        // 第 3 个 job 触发风控
        if (job.id === 'j3') throw new GuardError('环境异常, 请稍后再试', 'anti_bot')
      },
      loginByQR: async () => {},
      notifier: {
        notify: async (level, msg) => { notifyCalls.push({ level, msg }) },
      },
      accountMeta: metaDay15,
      config: baseConfig,
      sleep: async () => {},
    }

    const result = await runDailyLoop(deps, '2026-07-28')

    expect(result.stats.blocked).toBe(true)
    expect(result.exitCode).toBe(2)
    expect(result.state).toBe('blocked')
    // j1 j2 ok, j3 guard, j4 j5 未尝试
    expect(result.stats.sent).toBeLessThan(5)
    expect(result.stats.failed).toBe(0)  // GuardError 不算 per-job failed, 算 blocked
    expect(result.stats.ok).toBe(2)  // j1 j2 ok

    // notifier critical 应被调用, msg 含 [AUTO.runner] + 反爬
    const critical = notifyCalls.filter(c => c.level === 'critical')
    expect(critical.length).toBeGreaterThanOrEqual(1)
    expect(critical[0].msg).toMatch(/AUTO\.runner/)
    expect(critical[0].msg).toMatch(/anti_bot|反爬|风控/)
  })
})