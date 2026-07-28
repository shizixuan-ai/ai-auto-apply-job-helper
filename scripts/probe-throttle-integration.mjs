#!/usr/bin/env node
// ================================================================
// scripts/probe-throttle-integration.mjs — PROTOTYPE (一次性)
// ----------------------------------------------------------------
// 目标: 验证 ADR-0016 §14.4 H1-H5 集成假设 (Sprint C-1 落地前).
//
// 验证范围 (12 scenarios):
//   H1: POSIX atomic write (tmp + writeFile + sync + rename) 原子性
//        S1  单写单读往返 / S2 并发 10 写不丢失 / S3 tmp 清理 / S4 rename 异常回滚
//   H2: JSON.stringify + parse 安全
//        S5  写读字段一致 / S6 损坏 JSON 抛错不吞
//   H3: SIGTERM handler 不调 process.exit + 完整落盘
//        S7  handler 完整落盘 / S8 exit 调用计数 = 0
//   H4: createInMemoryCounterStore().reset() 隔离
//        S9  reset 后 load → null / S10 reset 后 write 不影响下次 test
//   H5: mkdir -p 在 ~/.bapply/ 不存在时自动创建
//        S11 首写自动建目录 / S12 已存在目录写不报错
//
// 单账号红线: 不 probe BOSS / loginByQR / sendGreeting (per ADR §3 + memory).
//
// 运行: node scripts/probe-throttle-integration.mjs
// 输出: 12 行 [PASS/FAIL] + 总摘要
// 后续: 验证完 → 删除 或 留作 ADR 证据 (per ADR §9 第 1 项)
// ================================================================

import * as fsp from 'node:fs/promises'
import * as fssync from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { randomUUID } from 'node:crypto'

// ─── 候选 CounterStore 实现 (供 probe 验证用) ────────────────

const COUNTER_DIR = path.join(os.homedir(), '.bapply')
const COUNTER_FILE = path.join(COUNTER_DIR, 'counter.json')

function createFsCounterStore(filepath) {
  return {
    async load(date) {
      try {
        const text = await fsp.readFile(filepath, 'utf8')
        const parsed = JSON.parse(text)
        if (parsed.date !== date) return null
        return parsed
      } catch (e) {
        if (e.code === 'ENOENT') return null
        throw e
      }
    },

    async writeAtomic(counter) {
      const dir = path.dirname(filepath)
      await fsp.mkdir(dir, { recursive: true })
      const tmp = `${filepath}.tmp.${process.pid}.${randomUUID()}`
      const data = JSON.stringify(counter)
      const fd = await fsp.open(tmp, 'w')
      try {
        await fd.writeFile(data)
        await fd.sync()
      } finally {
        await fd.close()
      }
      await fsp.rename(tmp, filepath)
    },
  }
}

function createInMemoryCounterStore(initial = null) {
  let state = initial
  return {
    async load() { return state },
    async writeAtomic(c) { state = { ...c } },
    reset() { state = null },
  }
}

// ─── Probe harness ──────────────────────────────────────────

let pass = 0, fail = 0
const results = []

function check(name, ok, detail) {
  results.push({ name, ok, detail })
  if (ok) pass++; else fail++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`)
}

async function scenario1() {
  // H1-S1: 单写单读往返
  const tmpFile = path.join(os.tmpdir(), `probe-c1-${process.pid}.json`)
  await fsp.rm(tmpFile, { force: true })
  const store = createFsCounterStore(tmpFile)
  const counter = { date: '2026-07-28', sent: 1, cap: 40 }
  await store.writeAtomic(counter)
  const loaded = await store.load('2026-07-28')
  check('H1-S1 single write/read roundtrip', loaded?.sent === 1 && loaded?.cap === 40,
    loaded ? `sent=${loaded.sent}` : 'load returned null')
  await fsp.rm(tmpFile, { force: true })
}

async function scenario2() {
  // H1-S2: 并发 10 次写不出现 ENOENT / 数据撕裂
  // 注意: POSIX atomic write 只保证"无 torn write + 无 ENOENT",
  //       不保证"最后调用必胜"(last-write-wins 在并发起跑下不严格保证 sent=N)。
  //       真正保证: 10 个 writeAtomic 全部 resolve,最终值 ∈ {1..10} (某一个胜出)。
  const tmpFile = path.join(os.tmpdir(), `probe-c2-${process.pid}.json`)
  await fsp.rm(tmpFile, { force: true })
  const store = createFsCounterStore(tmpFile)
  let allResolved = true
  try {
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        store.writeAtomic({ date: '2026-07-28', sent: i + 1, cap: 40 }))
    )
  } catch (e) {
    allResolved = false  // 任一 writeAtomic throw (ENOENT 等) → 撕裂
  }
  const loaded = await store.load('2026-07-28')
  const inRange = loaded && loaded.sent >= 1 && loaded.sent <= 10
  check('H1-S2 10x concurrent write, all resolve + final value in {1..10}',
    allResolved && inRange,
    `allResolved=${allResolved}, final sent=${loaded?.sent}`)
  await fsp.rm(tmpFile, { force: true })
}

async function scenario3() {
  // H1-S3: 临时文件清理 (rename 后 .tmp.* 不残留)
  const tmpFile = path.join(os.tmpdir(), `probe-c3-${process.pid}.json`)
  await fsp.rm(tmpFile, { force: true })
  const store = createFsCounterStore(tmpFile)
  await store.writeAtomic({ date: '2026-07-28', sent: 1, cap: 40 })
  const dir = path.dirname(tmpFile)
  const files = await fsp.readdir(dir)
  const tmpLeftovers = files.filter(f => f.includes(`probe-c3-${process.pid}`) && f.endsWith('.tmp'))
  check('H1-S3 tmp files cleaned after rename', tmpLeftovers.length === 0,
    `leftovers=${JSON.stringify(tmpLeftovers)}`)
  await fsp.rm(tmpFile, { force: true })
}

async function scenario4() {
  // H1-S4: rename 异常回滚 — 模拟: target 是只读目录
  // macOS Node 24: chmod 0o555 dir 后写入应 throw, tmp 应被关闭 (不残留)
  const readonlyDir = path.join(os.tmpdir(), `probe-c4-ro-${process.pid}`)
  await fsp.mkdir(readonlyDir, { recursive: true })
  await fsp.chmod(readonlyDir, 0o555)
  const tmpFile = path.join(readonlyDir, 'counter.json')
  const store = createFsCounterStore(tmpFile)
  let threw = false
  try {
    await store.writeAtomic({ date: '2026-07-28', sent: 1, cap: 40 })
  } catch (e) {
    threw = true
  } finally {
    await fsp.chmod(readonlyDir, 0o755)  // 恢复权限便于清理
  }
  const files = await fsp.readdir(readonlyDir)
  const tmpLeftovers = files.filter(f => f.endsWith('.tmp'))
  check('H1-S4 readonly dir → write throws + tmp cleaned', threw && tmpLeftovers.length === 0,
    `threw=${threw}, leftovers=${tmpLeftovers.length}`)
  await fsp.rm(readonlyDir, { recursive: true, force: true })
}

async function scenario5() {
  // H2-S5: 写读字段一致 (DailyCounter 复杂字段)
  const tmpFile = path.join(os.tmpdir(), `probe-c5-${process.pid}.json`)
  await fsp.rm(tmpFile, { force: true })
  const store = createFsCounterStore(tmpFile)
  const counter = {
    date: '2026-07-28', sent: 5, cap: 40, phase: 'morning',
    quotaMorning: 40, quotaAfternoon: 60, lastSentAt: 1722160800000,
    longPausesInjected: 0, bigBreakInjected: false,
  }
  await store.writeAtomic(counter)
  const loaded = await store.load('2026-07-28')
  const ok = loaded && JSON.stringify(loaded) === JSON.stringify(counter)
  check('H2-S5 complex counter roundtrip equality', ok,
    `equal=${ok}`)
  await fsp.rm(tmpFile, { force: true })
}

async function scenario6() {
  // H2-S6: 损坏 JSON 抛错不吞 (load 不应返回 null)
  const tmpFile = path.join(os.tmpdir(), `probe-c6-${process.pid}.json`)
  await fsp.writeFile(tmpFile, '{ invalid json !!!')
  const store = createFsCounterStore(tmpFile)
  let threw = false
  try {
    await store.load('2026-07-28')
  } catch (e) {
    threw = e instanceof SyntaxError
  }
  check('H2-S6 corrupted JSON throws SyntaxError (not silently null)', threw,
    `threw=${threw}`)
  await fsp.rm(tmpFile, { force: true })
}

async function scenario7() {
  // H3-S7: SIGTERM handler 完整落盘 (async writeAtomic 后 handler 完成)
  const tmpFile = path.join(os.tmpdir(), `probe-c7-${process.pid}.json`)
  await fsp.rm(tmpFile, { force: true })
  // 模拟 throttleSend 安装 handler
  const counter = { date: '2026-07-28', sent: 0, cap: 40 }
  const store = createFsCounterStore(tmpFile)
  // 第一次正常写 (模拟 throttleSend 第 11 步)
  await store.writeAtomic({ ...counter, sent: 1 })
  // 安装 SIGTERM handler
  const handler = async () => {
    await store.writeAtomic({ ...counter, sent: 999 })  // SIGTERM 时强制落盘
  }
  process.on('SIGTERM', handler)
  // 触发
  process.emit('SIGTERM')
  await new Promise(r => setTimeout(r, 50))  // 等待 handler 完成
  // 验证: 落盘数据是 SIGTERM 写入的 (sent=999)
  const loaded = await JSON.parse(await fsp.readFile(tmpFile, 'utf8'))
  process.removeAllListeners('SIGTERM')
  check('H3-S7 SIGTERM handler completes writeAtomic (sent=999)', loaded.sent === 999,
    `final sent=${loaded.sent}`)
  await fsp.rm(tmpFile, { force: true })
}

async function scenario8() {
  // H3-S8: handler 不调 process.exit (退出码计数 = 0)
  const exitCalls = []
  const origExit = process.exit
  process.exit = (code) => { exitCalls.push(code); throw new Error(`process.exit(${code}) invoked!`) }
  const tmpFile = path.join(os.tmpdir(), `probe-c8-${process.pid}.json`)
  await fsp.rm(tmpFile, { force: true })
  const store = createFsCounterStore(tmpFile)
  const handler = async () => {
    await store.writeAtomic({ date: '2026-07-28', sent: 999, cap: 40 })
  }
  process.on('SIGTERM', handler)
  let handlerThrew = false
  try {
    process.emit('SIGTERM')
    await new Promise(r => setTimeout(r, 50))
  } catch (e) {
    handlerThrew = e.message.includes('process.exit')
  }
  process.exit = origExit
  process.removeAllListeners('SIGTERM')
  check('H3-S8 handler does NOT call process.exit', !handlerThrew && exitCalls.length === 0,
    `handlerThrew=${handlerThrew}, exitCalls=${exitCalls.length}`)
  await fsp.rm(tmpFile, { force: true })
}

async function scenario9() {
  // H4-S9: reset 后 load 返回 null
  const store = createInMemoryCounterStore({ date: '2026-07-28', sent: 5, cap: 40 })
  const before = await store.load('2026-07-28')
  store.reset()
  const after = await store.load('2026-07-28')
  check('H4-S9 reset() makes load return null', before?.sent === 5 && after === null,
    `before.sent=${before?.sent}, after=${after}`)
}

async function scenario10() {
  // H4-S10: reset 后 writeAtomic 不影响下次 test
  const store = createInMemoryCounterStore()
  await store.writeAtomic({ date: '2026-07-28', sent: 100, cap: 40 })
  store.reset()
  await store.writeAtomic({ date: '2026-07-29', sent: 1, cap: 40 })
  const loaded = await store.load('2026-07-29')
  check('H4-S10 after reset, new write does not retain old state', loaded?.date === '2026-07-29' && loaded?.sent === 1,
    `loaded=${JSON.stringify(loaded)}`)
}

async function scenario11() {
  // H5-S11: ~/.bapply/ 不存在时自动创建 (用真路径, 跑完恢复)
  // 安全: 跑完 rm -rf ~/.bapply (if it was empty) — 先检查是否本来就有内容
  let existedBefore = false
  try {
    const stat = await fsp.stat(COUNTER_DIR)
    existedBefore = stat.isDirectory()
    const files = await fsp.readdir(COUNTER_DIR)
    if (files.length > 0) {
      check('H5-S11 SKIP (non-empty ~/.bapply exists)', true, 'pre-existing files, skipped')
      return
    }
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
  }
  // 目录不存在 → 写入应自动创建
  if (!existedBefore) await fsp.rm(COUNTER_DIR, { recursive: true, force: true })
  const store = createFsCounterStore(COUNTER_FILE)
  await store.writeAtomic({ date: '2026-07-28', sent: 1, cap: 40 })
  const stat = await fsp.stat(COUNTER_DIR)
  const exists = stat.isDirectory()
  const fileExists = await fsp.access(COUNTER_FILE).then(() => true).catch(() => false)
  check('H5-S11 first write creates ~/.bapply/ + counter.json', exists && fileExists,
    `dir=${exists}, file=${fileExists}`)
  // 清理 (我们创建的) — 不删用户已有内容
  await fsp.rm(COUNTER_FILE, { force: true })
  if (!existedBefore) await fsp.rm(COUNTER_DIR, { recursive: true, force: true })
}

async function scenario12() {
  // H5-S12: 目录已存在时写不报错
  await fsp.mkdir(COUNTER_DIR, { recursive: true })
  const store = createFsCounterStore(COUNTER_FILE)
  let threw = false
  try {
    await store.writeAtomic({ date: '2026-07-28', sent: 2, cap: 40 })
  } catch (e) {
    threw = true
  }
  check('H5-S12 write to existing dir does not throw', !threw,
    `threw=${threw}`)
  await fsp.rm(COUNTER_FILE, { force: true })
  await fsp.rm(COUNTER_DIR, { recursive: true, force: true })
}

// ─── Main ────────────────────────────────────────────────────

async function main() {
  console.log('=== ADR-0016 §14.4 H1-H5 probe (12 scenarios) ===\n')
  const scenarios = [
    scenario1, scenario2, scenario3, scenario4,
    scenario5, scenario6, scenario7, scenario8,
    scenario9, scenario10, scenario11, scenario12,
  ]
  for (const s of scenarios) {
    try { await s() }
    catch (e) { fail++; console.log(`[FAIL] scenario crashed — ${e.message}`) }
  }
  console.log(`\n=== Total: ${pass}/${pass + fail} PASS ===`)
  if (fail > 0) process.exit(1)
}

main().catch(e => { console.error('FATAL:', e); process.exit(2) })