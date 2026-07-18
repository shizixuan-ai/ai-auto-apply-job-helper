// ============================================================
// smoke-agent-runner.test.ts — RED tests
// ============================================================
// Sprint Smoke 1（2026-07-10）：
//   smoke-agent-runner.mjs 核心契约
//
// 契约：
//   - 输入：{ id, command, timeout_sec }[] 数组
//   - 并行 spawn（Promise.allSettled）
//   - 单 Agent 超时后 kill，返 partial stdout/stderr
//   - 总超时 300s 后强制终止剩余
//   - 输出 JSON: { id, status, exitCode, stdout, stderr, duration_ms, error }
//   - status: 'passed' | 'failed' | 'timeout' | 'skipped'
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ============================================================
// Mock child_process.spawn（在 import runner 之前）
// ------------------------------------------------------------
// 用 vi.hoisted + vi.mock：必须先于 import 注册
// ============================================================
const { mockSpawn } = vi.hoisted(() => ({
  // Mock spawn：返回一个 EventEmitter-like 对象
  mockSpawn: vi.fn(),
}))

vi.mock('node:child_process', () => ({
  spawn: mockSpawn,
}))

// 动态 import（在 mock 之后）
async function freshRunner() {
  vi.resetModules()
  return await import('./smoke-agent-runner.mjs')
}

// ============================================================
// helpers
// ============================================================
import { EventEmitter } from 'node:events'

/** 创建 mock child process（EventEmitter + stdout/stderr） */
function makeMockChild() {
  const child = new EventEmitter() as any
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = vi.fn()
  child.pid = 12345
  return child
}

beforeEach(() => {
  mockSpawn.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ============================================================
// TEST 1: 基本契约 — 并行 spawn + 成功路径
// ============================================================
describe('runSmokeAgents — 基本契约', () => {
  it('TEST 1: 单个 trigger 成功执行 → 返 status="passed" + exitCode=0', async () => {
    const child = makeMockChild()
    mockSpawn.mockReturnValue(child)

    const { runSmokeAgents } = await freshRunner()
    const promise = runSmokeAgents([
      { id: 'test-ok', command: 'echo hello', timeout_sec: 5 },
    ], { totalTimeoutMs: 30_000 })

    // 模拟子进程立即成功
    setImmediate(() => {
      child.stdout.emit('data', Buffer.from('hello\n'))
      child.emit('close', 0)
    })

    const results = await promise
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({
      id: 'test-ok',
      status: 'passed',
      exitCode: 0,
    })
    expect(results[0]?.stdout).toContain('hello')
    expect(results[0]?.duration_ms).toBeGreaterThanOrEqual(0)
  })

  // ============================================================
  // TEST 2: 单 Agent 超时 → status="timeout" + partial output
  // ============================================================
  it('TEST 2: 单 Agent 超时 → status="timeout" + 部分 stdout 被保留', async () => {
    const child = makeMockChild()
    mockSpawn.mockReturnValue(child)

    // 先切到 fake timer，让 runner 内部的 setTimeout 可被 advanceTimers 推进
    vi.useFakeTimers()

    const { runSmokeAgents } = await freshRunner()
    const promise = runSmokeAgents([
      { id: 'slow-agent', command: 'sleep 10', timeout_sec: 1 },
    ], { totalTimeoutMs: 30_000 })

    // 让 microtask queue 处理 spawn 注册
    await vi.advanceTimersByTimeAsync(0)

    // 模拟子进程返回部分 stdout 后挂住（不 emit close）
    child.stdout.emit('data', Buffer.from('partial output\n'))

    // 推进 fake timer 超过 timeout_sec
    await vi.advanceTimersByTimeAsync(1500)

    // 关键断言 1：kill 被调
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')

    // 关键断言 2：手动 emit close（带 null exitCode 模拟 SIGTERM）
    child.emit('close', null)
    await Promise.resolve() // 让 runner 处理 close event

    vi.useRealTimers()

    const results = await promise
    expect(results[0]).toMatchObject({
      id: 'slow-agent',
      status: 'timeout',
    })
    // 部分 stdout 仍保留
    expect(results[0]?.stdout).toContain('partial output')
    expect(results[0]?.error).toMatch(/timeout/i)
  })

  // ============================================================
  // TEST 3: 并行 — 两个 trigger 同时跑
  // ============================================================
  it('TEST 3: 多个 trigger 并行 spawn（不是串行）', async () => {
    const child1 = makeMockChild()
    const child2 = makeMockChild()
    mockSpawn.mockReturnValueOnce(child1).mockReturnValueOnce(child2)

    const { runSmokeAgents } = await freshRunner()
    const promise = runSmokeAgents([
      { id: 'agent-a', command: 'sleep 2', timeout_sec: 5 },
      { id: 'agent-b', command: 'sleep 2', timeout_sec: 5 },
    ], { totalTimeoutMs: 30_000 })

    // 验证 spawn 被调 2 次（并行）
    expect(mockSpawn).toHaveBeenCalledTimes(2)

    // 同时成功
    setImmediate(() => {
      child1.emit('close', 0)
      child2.emit('close', 0)
    })

    const results = await promise
    expect(results).toHaveLength(2)
    expect(results.map((r) => r.id).sort()).toEqual(['agent-a', 'agent-b'])
    expect(results.every((r) => r.status === 'passed')).toBe(true)
  })

  // ============================================================
  // TEST 4: 子进程非 0 退出 → status="failed" + stderr 保留
  // ============================================================
  it('TEST 4: 子进程 exit 1 → status="failed" + stderr 保留', async () => {
    const child = makeMockChild()
    mockSpawn.mockReturnValue(child)

    const { runSmokeAgents } = await freshRunner()
    const promise = runSmokeAgents([
      { id: 'fail-agent', command: 'false', timeout_sec: 5 },
    ], { totalTimeoutMs: 30_000 })

    setImmediate(() => {
      child.stderr.emit('data', Buffer.from('command not found\n'))
      child.emit('close', 1)
    })

    const results = await promise
    expect(results[0]).toMatchObject({
      id: 'fail-agent',
      status: 'failed',
      exitCode: 1,
    })
    expect(results[0]?.stderr).toContain('command not found')
  })

  // ============================================================
  // TEST 5: spawn 抛错（命令不存在 / 权限拒绝）→ status="failed" + error
  // ============================================================
  it('TEST 5: spawn 抛错 → status="failed" + error 信息', async () => {
    mockSpawn.mockImplementation(() => {
      throw new Error('spawn ENOENT')
    })

    const { runSmokeAgents } = await freshRunner()
    const results = await runSmokeAgents([
      { id: 'missing-cmd', command: 'nonexistent-cmd-xyz', timeout_sec: 5 },
    ], { totalTimeoutMs: 30_000 })

    expect(results[0]).toMatchObject({
      id: 'missing-cmd',
      status: 'failed',
    })
    expect(results[0]?.error).toContain('ENOENT')
    expect(results[0]?.duration_ms).toBeGreaterThanOrEqual(0)
  })
})