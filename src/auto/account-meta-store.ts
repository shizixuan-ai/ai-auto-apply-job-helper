// ============================================================
// src/auto/account-meta-store.ts — Sprint D-1b §16.5 GREEN
// ------------------------------------------------------------
// 状态: GREEN (per §4.1, RED 已确认 T25a/T25b FAIL, T25c PASS 向后兼容)
// 覆盖: ADR-0016 §16.3.3 关系图 (缺口 4)
//   - AccountMetaStore: load/save/recordBlock/regressWarmup
//   - POSIX atomic write (复用 §14.8 F1-F5, 防回退 writeFile+openSync 伪原子)
//   - createFsAccountMetaStore (真实 fs) + createInMemoryAccountMetaStore (test + reset)
//   - AccountMetaError class (layer='META' per §3.13) + cause 链保留
// 纪律: §3.13 错误分层 (this.layer='META' as const, throw 一律加 cause 链);
//       §3.12 mock 注入 (in-memory store 与 fs store 行为一致);
//       §3.10 refactor: 现有 caller (counter-store / throttle) 0 改 (独立模块)
// 单账号红线守住: 仅 fs + in-memory, 0 触碰 BOSS
// ============================================================

import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AccountMeta } from './throttle'

// ─── AccountMetaError (per §3.13) ─────────────────────────────

export type AccountMetaErrorCode = 'read_failed' | 'parse_failed' | 'write_failed' | 'rename_failed'

/**
 * §16 D-1b + §3.13: 账号 meta 持久化失败时抛出 (4 种 code).
 * auto-handler catch 后打印用户友好消息,不阻断 run (counter 已 +1).
 *
 * @example
 *   throw new AccountMetaError('write_failed', { cause: eaccesErr })
 */
export class AccountMetaError extends Error {
  readonly layer = 'META' as const  // per §3.13

  constructor(
    public code: AccountMetaErrorCode,
    options?: ErrorOptions,
  ) {
    super(`account_meta(${code})`, options)
    this.name = 'AccountMetaError'
  }
}

/** Type guard: 安全识别 AccountMetaError */
export function isAccountMetaError(e: unknown): e is AccountMetaError {
  return e instanceof AccountMetaError
}

// ─── AccountMetaStore 接口 ────────────────────────────────────

/**
 * 风控触发原因 (per §14.2.3 GuardError + §16.3.2 高失败率)
 * account-meta-store 不耦合 guard.ts, 用 string 接收所有 reason
 */
export type BlockReason = string

/**
 * 账号 meta 持久化层 (per ADR §16.3.3 关系图).
 *
 * @see tests/unit/cli/handlers/auto-handler-guard.test.ts T25
 */
export interface AccountMetaStore {
  /** 读取 (ENOENT → 自动 init defaults 返回) */
  load(): Promise<AccountMeta>
  /** POSIX atomic write (tmp + sync + rename, 复用 §14.8 F1-F5) */
  save(meta: AccountMeta): Promise<void>
  /** 持久化 blockedHistory + 触发降档逻辑由 caller 处理 */
  recordBlock(reason: BlockReason, error: Error | null): Promise<AccountMeta>
  /** 连续 blocked 超阈时降档 (old → warm → new) */
  regressWarmup(): Promise<AccountMeta>
}

// ─── 默认初始化 ───────────────────────────────────────────────

/** 默认 AccountMeta (首次 load() ENOENT 时用) */
export function createDefaultAccountMeta(): AccountMeta {
  return {
    registeredAt: Date.now(),
    accountAgeDays: 0,
    baseDailyCap: 30,
    targetDailyCap: 100,
    weeklyCap: 500,
    warmupSchedule: [
      { dayStart: 1, cap: 50 },
      { dayStart: 8, cap: 70 },
      { dayStart: 15, cap: 100 },
    ],
    currentTier: 'new',
    blockedHistory: [],
  }
}

/** 补齐缺失字段 (兼容老版本 account-meta.json 无 currentTier/blockedHistory) */
function fillDefaults(meta: Partial<AccountMeta>): AccountMeta {
  return {
    ...createDefaultAccountMeta(),
    ...meta,
    warmupSchedule: meta.warmupSchedule ?? createDefaultAccountMeta().warmupSchedule,
    currentTier: meta.currentTier ?? 'old',  // 老数据无 tier 字段 = 已过 warmup
    blockedHistory: meta.blockedHistory ?? [],
  }
}

// ─── 真实 fs AccountMetaStore (POSIX atomic) ──────────────────

export interface FsAccountMetaStoreOpts {
  rename?: (src: string, dst: string) => Promise<void>
}

/**
 * 真实 fs 账号 meta 持久化 (per §16.3.3 + §14.8 F1+F2+F4).
 * 写入流程与 counter-store.ts 一致 (POSIX atomic 模式):
 *   1. mkdir -p (F4)
 *   2. open(tmp, 'w') + writeFile + sync (fsync)
 *   3. rename(tmp, target) ← POSIX 原子 (F2)
 *      失败时清理 tmp 防泄漏
 *
 * @param filepath account-meta.json 完整路径 (含 ~/.bapply/ 前缀)
 */
export function createFsAccountMetaStore(
  filepath: string,
  opts?: FsAccountMetaStoreOpts,
): AccountMetaStore {
  const renameFn = opts?.rename ?? fsp.rename

  return {
    async load() {
      let text: string
      try {
        text = await fsp.readFile(filepath, 'utf8')
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
          // 首次运行: 自动 init defaults + 持久化
          const defaults = createDefaultAccountMeta()
          try {
            await this.save(defaults)
          } catch {
            // save 失败仍返回 defaults (caller 后续 recordBlock 时再重试 save)
            return defaults
          }
          return defaults
        }
        throw new AccountMetaError('read_failed', { cause: e })
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch (e) {
        throw new AccountMetaError('parse_failed', { cause: e })
      }
      return fillDefaults(parsed as Partial<AccountMeta>)
    },

    async save(meta) {
      const dir = path.dirname(filepath)
      try {
        await fsp.mkdir(dir, { recursive: true })
      } catch (e) {
        throw new AccountMetaError('write_failed', { cause: e })
      }
      const tmp = `${filepath}.tmp.${process.pid}.${randomUUID()}`  // F1: randomUUID
      const data = JSON.stringify(meta, null, 2)
      let fd: import('node:fs/promises').FileHandle | null = null
      try {
        fd = await fsp.open(tmp, 'w')
        await fd.writeFile(data)
        await fd.sync()
        await fd.close()
        fd = null
        await renameFn(tmp, filepath)
      } catch (e) {
        if (fd) await fd.close().catch(() => { /* best-effort */ })
        await fsp.rm(tmp, { force: true }).catch(() => { /* best-effort */ })
        throw new AccountMetaError('write_failed', { cause: e })
      }
    },

    async recordBlock(reason, _error) {
      const meta = await this.load()
      const updated: AccountMeta = {
        ...meta,
        blockedHistory: [
          ...(meta.blockedHistory ?? []),
          { ts: Date.now(), reason },
        ],
        currentTier: meta.currentTier ?? 'old',
      }
      await this.save(updated)
      return updated
    },

    async regressWarmup() {
      const meta = await this.load()
      const tierOrder = ['new', 'warm', 'old'] as const
      const idx = tierOrder.indexOf(meta.currentTier ?? 'old')
      const newTier = idx > 0 ? tierOrder[idx - 1]! : (meta.currentTier ?? 'old')
      const updated: AccountMeta = { ...meta, currentTier: newTier }
      await this.save(updated)
      return updated
    },
  }
}

// ─── 内存 AccountMetaStore (单元测试用, R7 reset) ──────────────

/**
 * 内存账号 meta store (单测用, R7 提供 reset() 隔离).
 * 行为与 fs store 一致: load() 不存在返默认值, recordBlock/regressWarmup 修改内存 state.
 */
export function createInMemoryAccountMetaStore(
  initial: AccountMeta | null = null,
): AccountMetaStore & { reset(): void } {
  let state: AccountMeta | null = initial

  return {
    async load() {
      if (!state) {
        state = createDefaultAccountMeta()
      }
      return { ...state, blockedHistory: [...(state.blockedHistory ?? [])] }
    },

    async save(meta) {
      state = { ...meta, blockedHistory: [...(meta.blockedHistory ?? [])] }
    },

    async recordBlock(reason, _error) {
      if (!state) state = createDefaultAccountMeta()
      const updated: AccountMeta = {
        ...state,
        blockedHistory: [
          ...(state.blockedHistory ?? []),
          { ts: Date.now(), reason },
        ],
        currentTier: state.currentTier ?? 'old',
      }
      state = updated
      return { ...updated, blockedHistory: [...updated.blockedHistory!] }
    },

    async regressWarmup() {
      if (!state) state = createDefaultAccountMeta()
      const tierOrder = ['new', 'warm', 'old'] as const
      const idx = tierOrder.indexOf(state.currentTier ?? 'old')
      const newTier = idx > 0 ? tierOrder[idx - 1]! : (state.currentTier ?? 'old')
      state = { ...state, currentTier: newTier }
      return { ...state, blockedHistory: [...state.blockedHistory!] }
    },

    reset() {
      state = null
    },
  }
}