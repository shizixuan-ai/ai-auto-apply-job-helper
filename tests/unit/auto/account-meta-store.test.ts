// ============================================================
// tests/unit/auto/account-meta-store.test.ts — Sprint D-1b §16.5 RED 补
// ------------------------------------------------------------
// 覆盖: T26-T30 (P0+P1 补)
//   T26: AccountMetaError 单元 (4 code + cause 链 + type guard)
//   T27: createFsAccountMetaStore fs 集成 (ENOENT→defaults + parse + write + rename 失败)
//   T28: regressWarmup tierOrder idx=0/1/2 边界
//   T29: createInMemoryAccountMetaStore recordBlock + load 默认
// 纪律: §3.13 错误分层 (layer='META' 验证);
//       §3.12 os.tmpdir + fs.mkdtemp 隔离;
//       §3.10 refactor: 0 改 Sprint C/D-1a 已有 caller
// 单账号红线守住: 仅 fs + in-memory, 0 触碰 BOSS
// ============================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import {
  createFsAccountMetaStore,
  createInMemoryAccountMetaStore,
  AccountMetaError,
  isAccountMetaError,
  createDefaultAccountMeta,
  type AccountMetaStore,
} from '../../../src/auto/account-meta-store'
import type { AccountMeta } from '../../../src/auto/throttle'

// ─── Tmp dir 管理 (per §3.12) ────────────────────────────────

let tmpDirs: string[] = []

const makeTmpDir = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(tmpdir(), 'account-meta-'))
  tmpDirs.push(dir)
  return dir
}

afterEach(async () => {
  for (const dir of tmpDirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => { /* best-effort */ })
  }
  tmpDirs = []
})

// ─── T26: AccountMetaError 单元 ──────────────────────────────

describe('T26: AccountMetaError class + isAccountMetaError (P0)', () => {
  it('T26a: 4 种 code 构造都成功 + layer=META', () => {
    const codes: Array<'read_failed' | 'parse_failed' | 'write_failed' | 'rename_failed'> = [
      'read_failed', 'parse_failed', 'write_failed', 'rename_failed',
    ]
    for (const code of codes) {
      const e = new AccountMetaError(code)
      expect(e.code).toBe(code)
      expect(e.layer).toBe('META')  // per §3.13
      expect(e.name).toBe('AccountMetaError')
      expect(e.message).toBe(`account_meta(${code})`)
      expect(e.cause).toBeUndefined()
    }
  })

  it('T26b: cause 链保留 (per §3.13)', () => {
    const orig = new Error('EACCES: permission denied')
    const wrapped = new AccountMetaError('write_failed', { cause: orig })
    expect(wrapped.cause).toBe(orig)
    expect(wrapped.cause?.message).toBe('EACCES: permission denied')
  })

  it('T26c: isAccountMetaError type guard', () => {
    const e = new AccountMetaError('parse_failed')
    expect(isAccountMetaError(e)).toBe(true)
    expect(isAccountMetaError(new Error('普通'))).toBe(false)
    expect(isAccountMetaError('string')).toBe(false)
    expect(isAccountMetaError(null)).toBe(false)
    expect(isAccountMetaError(undefined)).toBe(false)
  })
})

// ─── T27: createFsAccountMetaStore fs 集成 (P0) ──────────────

describe('T27: createFsAccountMetaStore fs 集成 (P0 — F1-F5 验证)', () => {
  it('T27a: ENOENT → 自动 init defaults + save', async () => {
    const dir = await makeTmpDir()
    const filepath = path.join(dir, 'account-meta.json')

    const store = createFsAccountMetaStore(filepath)
    const meta = await store.load()

    // 1. 返回 defaults
    expect(meta.registeredAt).toBeGreaterThan(0)
    expect(meta.currentTier).toBe('new')
    expect(meta.blockedHistory).toEqual([])
    expect(meta.warmupSchedule.length).toBe(3)

    // 2. save 已自动发生 (下次的 load 不再 ENOENT)
    const meta2 = await store.load()
    expect(meta2.currentTier).toBe('new')
  })

  it('T27b: parse 失败 → throw AccountMetaError(parse_failed, cause=SyntaxError)', async () => {
    const dir = await makeTmpDir()
    const filepath = path.join(dir, 'account-meta.json')
    await writeFile(filepath, '{ 损坏的 JSON')

    const store = createFsAccountMetaStore(filepath)

    try {
      await store.load()
      expect.fail('应该抛出 AccountMetaError')
    } catch (e) {
      expect(isAccountMetaError(e)).toBe(true)
      expect((e as AccountMetaError).code).toBe('parse_failed')
      expect((e as AccountMetaError).layer).toBe('META')
      expect((e as AccountMetaError).cause).toBeInstanceOf(SyntaxError)
    }
  })

  it('T27c: rename 失败 → tmp 清理 + throw AccountMetaError', async () => {
    const dir = await makeTmpDir()
    const filepath = path.join(dir, 'account-meta.json')

    // 注入 rename mock 抛错 (F2 验证: 失败时 tmp 清理)
    const renameMock = vi.fn(async () => {
      throw new Error('EACCES: simulated rename failure')
    })
    const store = createFsAccountMetaStore(filepath, { rename: renameMock })

    try {
      await store.save(createDefaultAccountMeta())
      expect.fail('应该抛出 AccountMetaError')
    } catch (e) {
      expect(isAccountMetaError(e)).toBe(true)
      expect((e as AccountMetaError).code).toBe('write_failed')
      expect((e as AccountMetaError).layer).toBe('META')
      expect((e as AccountMetaError).cause).toBeDefined()
    }

    // tmp 文件已清理 (F2)
    const { readdir } = await import('node:fs/promises')
    const files = await readdir(dir)
    const tmps = files.filter(f => f.includes('.tmp.'))
    expect(tmps.length).toBe(0)
  })

  it('T27d: recordBlock 持久化 blockedHistory (端到端 F1-F4)', async () => {
    const dir = await makeTmpDir()
    const filepath = path.join(dir, 'account-meta.json')

    const store = createFsAccountMetaStore(filepath)

    // 1. ENOENT → defaults
    const initial = await store.load()
    expect(initial.blockedHistory).toEqual([])

    // 2. recordBlock('anti_bot')
    const after1 = await store.recordBlock('anti_bot', new Error('环境异常'))
    expect(after1.blockedHistory?.length).toBe(1)
    expect(after1.blockedHistory?.[0]?.reason).toBe('anti_bot')

    // 3. recordBlock('high_failure_rate')
    const after2 = await store.recordBlock('high_failure_rate', null)
    expect(after2.blockedHistory?.length).toBe(2)
    expect(after2.blockedHistory?.[1]?.reason).toBe('high_failure_rate')

    // 4. 新 store 实例读同一文件 (持久化生效)
    const store2 = createFsAccountMetaStore(filepath)
    const loaded = await store2.load()
    expect(loaded.blockedHistory?.length).toBe(2)
  })

  it('T27e: 老数据无 currentTier/blockedHistory → fillDefaults 兼容', async () => {
    const dir = await makeTmpDir()
    const filepath = path.join(dir, 'account-meta.json')

    // 写老版本 JSON (无 currentTier/blockedHistory)
    await writeFile(filepath, JSON.stringify({
      registeredAt: 12345,
      accountAgeDays: 100,
      baseDailyCap: 30,
      targetDailyCap: 100,
      weeklyCap: 500,
      warmupSchedule: [{ dayStart: 1, cap: 50 }],
    }))

    const store = createFsAccountMetaStore(filepath)
    const loaded = await store.load()

    // fillDefaults 补齐缺失字段
    expect(loaded.currentTier).toBe('old')  // 老数据无 tier 字段 = 已过 warmup
    expect(loaded.blockedHistory).toEqual([])
    expect(loaded.warmupSchedule.length).toBe(1)  // 保留老数据
  })
})

// ─── T28: regressWarmup tierOrder 边界 (P2) ──────────────────

describe('T28: regressWarmup tierOrder 边界 (P2)', () => {
  it('T28a: currentTier=old → 降档 warm', async () => {
    const store = createInMemoryAccountMetaStore({
      ...createDefaultAccountMeta(),
      currentTier: 'old',
    })
    const after = await store.regressWarmup()
    expect(after.currentTier).toBe('warm')
  })

  it('T28b: currentTier=warm → 降档 new', async () => {
    const store = createInMemoryAccountMetaStore({
      ...createDefaultAccountMeta(),
      currentTier: 'warm',
    })
    const after = await store.regressWarmup()
    expect(after.currentTier).toBe('new')
  })

  it('T28c: currentTier=new → 保持 new (idx=0 边界, 不再降)', async () => {
    const store = createInMemoryAccountMetaStore({
      ...createDefaultAccountMeta(),
      currentTier: 'new',
    })
    const after = await store.regressWarmup()
    expect(after.currentTier).toBe('new')  // 已在最低档, 不再降
  })

  it('T28d: currentTier undefined → 默认 old → 降档 warm', async () => {
    const initial = { ...createDefaultAccountMeta() }
    delete (initial as { currentTier?: string }).currentTier
    const store = createInMemoryAccountMetaStore(initial)
    const after = await store.regressWarmup()
    expect(after.currentTier).toBe('warm')
  })
})

// ─── T29: createInMemoryAccountMetaStore recordBlock + load 默认 ──

describe('T29: createInMemoryAccountMetaStore (P1)', () => {
  it('T29a: load() null state → 自动 init defaults', async () => {
    const store = createInMemoryAccountMetaStore()
    const meta = await store.load()
    expect(meta.currentTier).toBe('new')
    expect(meta.blockedHistory).toEqual([])
  })

  it('T29b: recordBlock + load 持久化 (内存一致)', async () => {
    const store = createInMemoryAccountMetaStore()
    await store.recordBlock('anti_bot', new Error('test'))
    const loaded = await store.load()
    expect(loaded.blockedHistory?.length).toBe(1)
    expect(loaded.blockedHistory?.[0]?.reason).toBe('anti_bot')
  })

  it('T29c: reset() 隔离 test 间状态', async () => {
    const store = createInMemoryAccountMetaStore()
    await store.recordBlock('anti_bot', null)
    expect((await store.load()).blockedHistory?.length).toBe(1)

    store.reset()
    const after = await store.load()
    expect(after.blockedHistory).toEqual([])  // reset 后清空
    expect(after.currentTier).toBe('new')
  })
})