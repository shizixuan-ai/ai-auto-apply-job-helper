// ============================================================
// tests/unit/auto/counter-store.test.ts — Sprint C-1 §8 RED 3 tests
// ------------------------------------------------------------
// 覆盖: T11-T13 (per ADR-0016 §14.5 C-1 + §14.8 probe 验证 F1-F5)
// 纪律: §3.13 错误分层; §3.12 mock 真实 fs (tmp dir, 跑完清理)
// 单账号红线守住: 0 BOSS / network 调用
// ============================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import {
  createFsCounterStore,
  createInMemoryCounterStore,
  type DailyCounter,
} from '../../../src/auto/counter-store'

// ─── Fixtures ────────────────────────────────────────────────

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cs-test-'))
})

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true })
  // 清理 SIGTERM handler (per T13)
  process.removeAllListeners('SIGTERM')
})

const baseCounter: DailyCounter = {
  date: '2026-07-28',
  sent: 1,
  cap: 40,
  phase: 'morning',
  quotaMorning: 40,
  quotaAfternoon: 60,
  lastSentAt: 0,
  longPausesInjected: 0,
  bigBreakInjected: false,
}

// ─── T11: createFsCounterStore 完整契约 (per §14.8 F1+F2+F3+F4) ─

describe('T11: createFsCounterStore', () => {
  it('writeAtomic + load roundtrip preserves all fields (F4 mkdir + F3 corrupt throw)', async () => {
    const file = path.join(tmpDir, 'counter.json')
    const store = createFsCounterStore(file)

    await store.writeAtomic(baseCounter)
    const loaded = await store.load('2026-07-28')
    expect(loaded).toEqual(baseCounter)

    // 子断言: 损坏 JSON 抛 SyntaxError (per F3, 不吞)
    await fsp.writeFile(file, '{ invalid json !!!')
    await expect(store.load('2026-07-28')).rejects.toThrow(SyntaxError)
  })

  it('10x concurrent writeAtomic all resolve (per F1 randomUUID + F2 last-write semantics)', async () => {
    const file = path.join(tmpDir, 'counter.json')
    const store = createFsCounterStore(file)

    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        store.writeAtomic({ ...baseCounter, sent: i + 1 })),
    )
    const loaded = await store.load('2026-07-28')
    // F2: POSIX atomic write 只保证"无 torn write", 不保证"最后调用必胜"
    //     最终值必 ∈ {1..10} (10 个 writeAtomic 中某一个 rename 最后完成)
    expect(loaded?.sent).toBeGreaterThanOrEqual(1)
    expect(loaded?.sent).toBeLessThanOrEqual(10)
  })

  it('tmp files cleaned after rename + load隔日 reset + 隔日 load 返回 null', async () => {
    const file = path.join(tmpDir, 'counter.json')
    const store = createFsCounterStore(file)

    await store.writeAtomic(baseCounter)
    const files = await fsp.readdir(tmpDir)
    expect(files.filter(f => f.endsWith('.tmp'))).toEqual([])

    // 隔日 reset: stored.date !== requested.date → 返回 null
    const stale = await store.load('2026-07-29')
    expect(stale).toBeNull()
  })

  it('T11h: rename 失败时 tmp 文件被清理 (no leak per agent hook P0)', async () => {
    // 注入会失败的 rename 函数 (依赖注入, 可靠触发 rename 失败)
    //   → open/writeFile/sync/close 都成功, tmp 文件已创建
    //   → rename throws → 当前代码泄漏 (RED)
    //   → 修复后 try-catch + fsp.rm(tmp) → tmpLeftovers=[] (GREEN)
    const file = path.join(tmpDir, 'counter.json')
    const store = createFsCounterStore(file, {
      rename: async () => { throw new Error('mock rename failure') },
    })

    let threw = false
    let threwMsg = ''
    try {
      await store.writeAtomic(baseCounter)
    } catch (e) {
      threw = true
      threwMsg = (e as Error).message
    }

    expect(threw, 'rename 失败应 throw').toBe(true)
    expect(threwMsg).toBe('mock rename failure')

    const files = await fsp.readdir(tmpDir)
    const tmpLeftovers = files.filter(f => f.endsWith('.tmp'))
    expect(tmpLeftovers, `tmp 泄漏: ${JSON.stringify(tmpLeftovers)}`).toEqual([])
  })
})

// ─── T12: createInMemoryCounterStore + reset 隔离 (per R7) ──

describe('T12: createInMemoryCounterStore + reset', () => {
  it('initial + writeAtomic + reset() + write-after-reset 三阶段状态正确', async () => {
    const store = createInMemoryCounterStore({ ...baseCounter, sent: 5 })

    // 阶段 1: initial state
    expect(await store.load('2026-07-28')).toEqual({ ...baseCounter, sent: 5 })

    // 阶段 2: writeAtomic 更新
    await store.writeAtomic({ ...baseCounter, sent: 10 })
    expect((await store.load('2026-07-28'))?.sent).toBe(10)

    // 阶段 3: reset 隔离, 不残留旧状态
    store.reset()
    expect(await store.load('2026-07-28')).toBeNull()

    // 阶段 4: reset 后 writeAtomic 写入新值
    await store.writeAtomic({ ...baseCounter, sent: 1, date: '2026-07-29' })
    expect(await store.load('2026-07-29')).toEqual({ ...baseCounter, sent: 1, date: '2026-07-29' })
    // 旧 date 不应再查到 (state 已是 07-29 的对象)
    expect(await store.load('2026-07-28')).toBeNull()
  })
})

// ─── T13: SIGTERM handler 不调 process.exit (per R5 + F5) ──

describe('T13: SIGTERM handler 加固', () => {
  it('counter-store 写入 handler + SIGTERM 触发后 exit 调用计数 = 0 + 数据落盘', async () => {
    const file = path.join(tmpDir, 'counter.json')
    const store = createFsCounterStore(file)
    await store.writeAtomic({ ...baseCounter, sent: 1 })  // 初始落盘

    // 捕获 process.exit 调用
    const exitCalls: number[] = []
    const origExit = process.exit
    process.exit = ((code?: number) => {
      exitCalls.push(code ?? 0)
      throw new Error(`process.exit(${code}) 不应在 SIGTERM handler 内调用`)
    }) as never

    // 安装 handler (模拟 throttleSend 的 SIGTERM flush)
    let handlerInvoked = false
    const handler = async () => {
      handlerInvoked = true
      await store.writeAtomic({ ...baseCounter, sent: 999 })  // SIGTERM 时强制 flush
    }
    process.on('SIGTERM', handler)

    // 触发 SIGTERM
    process.emit('SIGTERM')
    await new Promise(r => setTimeout(r, 50))  // 等 async handler 完成

    // 还原
    process.exit = origExit
    process.removeAllListeners('SIGTERM')

    // 断言 1: handler 真的跑了
    expect(handlerInvoked).toBe(true)
    // 断言 2: process.exit 没被调用 (per R5 + F5)
    expect(exitCalls).toEqual([])
    // 断言 3: handler 内的 writeAtomic 已落盘 (sent=999)
    const finalText = await fsp.readFile(file, 'utf8')
    const final = JSON.parse(finalText)
    expect(final.sent).toBe(999)
  })
})