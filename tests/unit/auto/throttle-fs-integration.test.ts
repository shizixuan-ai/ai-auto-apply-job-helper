// ============================================================
// tests/unit/auto/throttle-fs-integration.test.ts — Sprint C-3 §14.5 RED
// ------------------------------------------------------------
// 覆盖: T19 (per ADR-0016 §14.5 C-3)
//   T19a: 真 fs 往返 (writeAtomic → load 字段一致)
//   T19b: 隔日 reset (write date=A → load date=B → null)
//   T19c: 损坏 JSON → load throws SyntaxError (per F3, 不吞)
//   T19d: writeAtomic 完成后 .tmp.* 文件清理 (per F1)
// 纪律: §3.12 mock 注入 (os.tmpdir + fs.mkdtemp 隔离, 每 test 独立目录);
//       §3.13 错误分层验证 (SyntaxError 不吞 → load 必 throw);
//       §3.10 refactor: 不动 throttle.ts 现有接口, 仅注入 createFsCounterStore
// 单账号红线守住: 仅 fs + in-memory, 0 触碰 BOSS
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import {
  throttleSend,
  ThrottleError,
  type ThrottleDeps,
  type AutoConfig,
  type AccountMeta,
  type DailyCounter,
} from '../../../src/auto/throttle'
import { createFsCounterStore } from '../../../src/auto/counter-store'

// ─── 共享 fake clock + seeded RNG (per §3.12) ────────────────

let _now = Date.now()
const now = () => _now
const setClock = (ms: number) => { _now = ms }

let _rngState = 0
const seedRandom = (seed: number) => { _rngState = seed >>> 0 }
const rand = (): number => {
  _rngState = (_rngState + 0x6D2B79F5) | 0
  let t = _rngState
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

beforeEach(() => {
  setClock(Date.now())
  seedRandom(0)
})

// ─── 默认 fixtures ───────────────────────────────────────────

const warmupSchedule = [
  { dayStart: 1, cap: 50 },
  { dayStart: 8, cap: 70 },
  { dayStart: 15, cap: 100 },
]

const metaDay15: AccountMeta = {
  registeredAt: Date.now() - 15 * 86_400_000,
  accountAgeDays: 15,
  baseDailyCap: 30,
  targetDailyCap: 100,
  weeklyCap: 500,
  warmupSchedule,
}

const baseConfig: AutoConfig = {
  dryRun: false,
  phase: 'morning',
  quota: { morning: 40, afternoon: 60, weekly_cap: 500 },
  throttle: {
    morning_interval_ms: [0, 1],     // 测试加速: 0-1ms
    afternoon_interval_ms: [0, 1],
    jitter_pct: 0,
    long_pause: { every_n_jobs: 100, duration_ms: [0, 1] },
    afternoon_mid_break: { after_job: 100, duration_ms: [0, 1] },
  },
}

const baseCounter: DailyCounter = {
  date: '2026-07-28',
  sent: 0,
  cap: 40,
  phase: 'morning',
  quotaMorning: 40,
  quotaAfternoon: 60,
  lastSentAt: 0,
  longPausesInjected: 0,
  bigBreakInjected: false,
}

const noopSendGreeting = async () => {}

// ─── Tmp dir 管理 (per §3.12 mock 隔离) ──────────────────────

let tmpDirs: string[] = []

const makeTmpDir = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(tmpdir(), 'throttle-fs-'))
  tmpDirs.push(dir)
  return dir
}

afterEach(async () => {
  for (const dir of tmpDirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => { /* best-effort */ })
  }
  tmpDirs = []
})

// ─── T19a: 真 fs 往返 ───────────────────────────────────────

describe('T19a: 真 fs 往返 (createFsCounterStore)', () => {
  it('writeAtomic → load 字段完全一致 (roundtrip)', async () => {
    const dir = await makeTmpDir()
    const filepath = path.join(dir, 'counter.json')
    const store = createFsCounterStore(filepath)

    // 初始 load → null (文件不存在)
    expect(await store.load('2026-07-28')).toBeNull()

    // 写入一个完整 counter
    const counter: DailyCounter = {
      ...baseCounter,
      sent: 5,
      lastSentAt: 1722155400000,
      longPausesInjected: 2,
    }
    await store.writeAtomic(counter)

    // 重新 load → 字段一致
    const loaded = await store.load('2026-07-28')
    expect(loaded).not.toBeNull()
    expect(loaded).toEqual(counter)
  })

  it('throttleSend 内部调用 writeAtomic 后, fs store 可读到 sent=1', async () => {
    const dir = await makeTmpDir()
    const filepath = path.join(dir, 'counter.json')
    const store = createFsCounterStore(filepath)

    setClock(new Date('2026-07-28T09:10:00').getTime())
    seedRandom(0)

    const deps: ThrottleDeps = {
      now,
      rand,
      counterStore: store,
      sendGreeting: noopSendGreeting,
      accountMeta: metaDay15,
    }

    await throttleSend({ id: 'j1' }, deps, baseConfig)

    // 关键: 真 fs 已写入
    const freshStore = createFsCounterStore(filepath)
    const loaded = await freshStore.load('2026-07-28')
    expect(loaded).not.toBeNull()
    expect(loaded?.sent).toBe(1)  // §12 Issue 1: counter++ 先持久化
    expect(loaded?.lastSentAt).toBe(_now)
  })
})

// ─── T19b: 隔日 reset ────────────────────────────────────────

describe('T19b: 隔日 reset', () => {
  it('writeAtomic(date="2026-07-28") → load(date="2026-07-29") → null', async () => {
    const dir = await makeTmpDir()
    const filepath = path.join(dir, 'counter.json')
    const store = createFsCounterStore(filepath)

    const counter: DailyCounter = { ...baseCounter, sent: 30 }
    await store.writeAtomic(counter)

    // 同日 load → 找到
    const sameDay = await store.load('2026-07-28')
    expect(sameDay).not.toBeNull()
    expect(sameDay?.sent).toBe(30)

    // 隔日 load → null (per counter-store load 第 4 步)
    const nextDay = await store.load('2026-07-29')
    expect(nextDay).toBeNull()
  })
})

// ─── T19c: 损坏 JSON → load throws SyntaxError (per F3) ──────

describe('T19c: 损坏 JSON → load throws SyntaxError (不吞)', () => {
  it('手工写入 {invalid json} → load 抛 SyntaxError', async () => {
    const dir = await makeTmpDir()
    const filepath = path.join(dir, 'counter.json')
    await writeFile(filepath, '{ not valid json')

    const store = createFsCounterStore(filepath)
    await expect(store.load('2026-07-28')).rejects.toThrow(SyntaxError)
  })

  it('手工写入空文件 → load 抛 SyntaxError (不返 null)', async () => {
    const dir = await makeTmpDir()
    const filepath = path.join(dir, 'counter.json')
    await writeFile(filepath, '')

    const store = createFsCounterStore(filepath)
    // 空文件 → JSON.parse 抛 (e.message includes "Unexpected end of JSON input")
    await expect(store.load('2026-07-28')).rejects.toThrow()
  })
})

// ─── T19d: writeAtomic 后 tmp 文件清理 (per F1) ──────────────

describe('T19d: writeAtomic 完成后 .tmp.* 文件 = 0', () => {
  it('正常 write 后目录内只有 counter.json, 无残留 .tmp.*', async () => {
    const dir = await makeTmpDir()
    const filepath = path.join(dir, 'counter.json')
    const store = createFsCounterStore(filepath)

    // 多次 write 模拟并发 (per probe H1-S2)
    await Promise.all([
      store.writeAtomic({ ...baseCounter, sent: 1 }),
      store.writeAtomic({ ...baseCounter, sent: 2 }),
      store.writeAtomic({ ...baseCounter, sent: 3 }),
    ])

    // 目录内应只有 counter.json, 无 .tmp.* 残留
    const files = await readdir(dir)
    const tmpFiles = files.filter(f => f.includes('.tmp.'))
    expect(tmpFiles.length).toBe(0)
    expect(files).toContain('counter.json')
  })

  it('writeAtomic 失败 (rename throw) → tmp 清理 (per agent hook P0 fix)', async () => {
    const dir = await makeTmpDir()
    const filepath = path.join(dir, 'counter.json')

    // 注入 rename 永远失败
    const store = createFsCounterStore(filepath, {
      rename: async () => { throw new Error('rename EPERM (injected)') },
    })

    await expect(
      store.writeAtomic({ ...baseCounter, sent: 1 }),
    ).rejects.toThrow(/EPERM/)

    // 关键: 失败时 tmp 必须清理, 不残留
    const files = await readdir(dir)
    const tmpFiles = files.filter(f => f.includes('.tmp.'))
    expect(tmpFiles.length).toBe(0)
    expect(files).not.toContain('counter.json')  // rename 失败 → real 文件未生成
  })
})
