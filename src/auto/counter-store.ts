// ============================================================
// src/auto/counter-store.ts — Sprint C-1 §14.4 H1+H2+H4+H5 实现
// ------------------------------------------------------------
// 状态: GREEN (per §4.1, probe 12/12 PASS 已证实 H1-H5)
// 覆盖: ADR-0016 §14.4
//   - H1: POSIX atomic write (tmp + writeFile + sync + rename)
//   - H2: JSON 安全 (损坏 throw 不吞)
//   - H4: in-memory reset() 隔离 (per R7)
//   - H5: mkdir -p 自动建 ~/.bapply/
// H3 (SIGTERM handler 不调 process.exit) 由 caller 控制, 见 throttle.ts.
// 纪律: §3.13 错误分层; §3.12 probe 验证 F1-F5 已落地 (见 §14.8).
//       in-memory store 同步 fs store 行为 (按 date 过滤).
// ============================================================

import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { DailyCounter } from './throttle'

/**
 * CounterStore 接口 (per ADR §14.2.3 关系图).
 * @see tests/unit/auto/counter-store.test.ts T11-T13
 */
export interface CounterStore {
  load(date: string): Promise<DailyCounter | null>
  writeAtomic(counter: DailyCounter): Promise<void>
}

/**
 * 真实 fs counter-store (POSIX atomic write).
 *
 * 写入流程 (per §14.8 F1+F4):
 *   1. mkdir -p (recursive) → 确保 ~/.bapply/ 存在 (F4)
 *   2. open(tmp, 'w') → fd  (tmp suffix 用 randomUUID 保证并发 unique, F1)
 *   3. writeFile(tmp) + sync (fsync)
 *   4. close
 *   5. rename(tmp, target) ← POSIX 原子 (F2: 不保证"最后调用必胜", 保证"无 torn write")
 *      失败时清理 tmp (per agent hook P0)
 *
 * 读取流程 (per §14.8 F3):
 *   1. readFile(target)
 *   2. ENOENT → null (首次运行 / 文件不存在)
 *   3. JSON.parse → SyntaxError 抛出, 不吞 (F3)
 *   4. parsed.date !== requested.date → null (隔日 reset)
 *   5. 返回 parsed
 *
 * @param filepath counter.json 完整路径 (含 ~/.bapply/ 前缀)
 * @param opts.rename 注入的 rename 函数 (默认 fsp.rename; 测试用 mock 触发失败)
 */
export interface FsCounterStoreOpts {
  rename?: (src: string, dst: string) => Promise<void>
}

export function createFsCounterStore(
  filepath: string,
  opts?: FsCounterStoreOpts,
): CounterStore {
  const renameFn = opts?.rename ?? fsp.rename
  return {
    async load(date) {
      let text: string
      try {
        text = await fsp.readFile(filepath, 'utf8')
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw e  // 其他错误 (EACCES, EISDIR 等) → 抛
      }
      const parsed = JSON.parse(text) as DailyCounter  // SyntaxError 抛出, 不吞 (F3)
      if (parsed.date !== date) return null  // 隔日 reset
      return parsed
    },

    async writeAtomic(counter) {
      const dir = path.dirname(filepath)
      await fsp.mkdir(dir, { recursive: true })  // F4: mkdir -p
      const tmp = `${filepath}.tmp.${process.pid}.${randomUUID()}`  // F1: randomUUID 避免同 ms 冲突
      const data = JSON.stringify(counter)
      const fd = await fsp.open(tmp, 'w')
      try {
        await fd.writeFile(data)
        await fd.sync()  // fsync tmp
      } finally {
        await fd.close()
      }
      // POSIX atomic rename; 失败时清理 tmp 防泄漏 (per agent hook P0)
      try {
        await renameFn(tmp, filepath)
      } catch (e) {
        await fsp.rm(tmp, { force: true }).catch(() => { /* best-effort */ })
        throw e
      }
    },
  }
}

/**
 * 内存 counter-store (单元测试用, 与 fs store 行为一致).
 *
 * 提供 .reset() 方法隔离 test 间状态 (per R7 + §14.3 refactor 盘点).
 * 按 date 过滤保持与 fs store 行为一致, 避免 caller 行为分裂.
 */
export function createInMemoryCounterStore(
  initial: DailyCounter | null = null,
): CounterStore & { reset(): void } {
  let state: DailyCounter | null = initial
  return {
    async load(date) {
      if (state && state.date === date) return state
      return null
    },
    async writeAtomic(counter) {
      state = { ...counter }
    },
    reset() {
      state = null
    },
  }
}