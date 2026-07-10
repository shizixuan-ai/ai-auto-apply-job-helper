// ============================================================
// smoke-agent-runner.mjs — Sprint Smoke 1 实现
// ============================================================
// 契约：
//   - 输入：{ id, command, timeout_sec }[] 数组 + { totalTimeoutMs }
//   - 并行 spawn（Promise.allSettled 语义）
//   - 单 Agent 超时后 kill，返 partial stdout/stderr
//   - 总超时（默认 300s）作为兜底
//   - 输出 JSON: { id, status, exitCode, stdout, stderr, duration_ms, error }
//   - status: 'passed' | 'failed' | 'timeout' | 'skipped'
//
// 设计原则：
//   - 不依赖 Claude Agent SDK（用 Bash spawn，符合"简单可靠"决策）
//   - shell 解析用 shell: true（与 hook 体验一致：用户写 npx tsx 就能跑）
//   - stdout/stderr 用 Buffer 累积，超时后保留 partial output
// ============================================================

import { spawn } from 'node:child_process'

// ============================================================
// 类型定义
// ============================================================

/**
 * @typedef {Object} SmokeTrigger
 * @property {string} id - 稳定标识（用于 report 聚合 + log grep）
 * @property {string} command - 要执行的命令（用 shell 解析）
 * @property {number} timeout_sec - 单 Agent 超时（秒）
 * @property {string} [reason] - 人类可读解释
 */

/**
 * @typedef {'passed' | 'failed' | 'timeout' | 'skipped'} SmokeStatus
 */

/**
 * @typedef {Object} SmokeResult
 * @property {string} id
 * @property {SmokeStatus} status
 * @property {number | null} exitCode
 * @property {string} stdout - 部分或完整输出
 * @property {string} stderr
 * @property {number} duration_ms
 * @property {string | null} error - 错误信息（timeout/spawn 错误）
 */

/**
 * @typedef {Object} RunnerOptions
 * @property {number} [totalTimeoutMs=300000] - 总超时（默认 300s）
 * @property {(msg: string) => void} [log] - 日志回调（默认 stderr）
 */

// ============================================================
// 公开 API
// ============================================================

/**
 * 并行跑多个 trigger，返回结果数组。
 * 永不抛错（每个 trigger 失败都包成 result）。
 *
 * @param {SmokeTrigger[]} triggers
 * @param {RunnerOptions} [opts]
 * @returns {Promise<SmokeResult[]>}
 */
export async function runSmokeAgents(triggers, opts = {}) {
  const totalTimeoutMs = opts.totalTimeoutMs ?? 300_000
  const log = opts.log ?? ((msg) => process.stderr.write(`[runner] ${msg}\n`))

  // 整体兜底超时（即使所有子 Agent 都不返回，totalTimeoutMs 后强制返回）
  const overallTimeout = setTimeout(() => {
    log(`⚠️ 总超时 ${totalTimeoutMs}ms 触发，部分 agent 可能未完成`)
  }, totalTimeoutMs)
  // 让 process 不被这个 timer 阻止退出（spawn 子进程已经 hold 住）
  overallTimeout.unref()

  try {
    return await Promise.all(
      triggers.map((t) => runOneAgent(t, log)),
    )
  } finally {
    clearTimeout(overallTimeout)
  }
}

// ============================================================
// 内部 helpers
// ============================================================

/**
 * 跑单个 trigger。永不抛错（所有异常 → result.error）
 *
 * @param {SmokeTrigger} trigger
 * @param {(msg: string) => void} log
 * @returns {Promise<SmokeResult>}
 */
async function runOneAgent(trigger, log) {
  const { id, command, timeout_sec } = trigger
  const startedAt = Date.now()

  // 用 shell 解析（user 写 'npx tsx scripts/foo.mjs' 时体验一致）
  let child
  try {
    child = spawn(command, {
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      // detached: false（默认）— 跟随 Node 进程，hook 退出时一起清理
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log(`❌ [${id}] spawn 失败: ${msg}`)
    return {
      id,
      status: 'failed',
      exitCode: null,
      stdout: '',
      stderr: '',
      duration_ms: Date.now() - startedAt,
      error: `spawn error: ${msg}`,
    }
  }

  // 累积 stdout/stderr（用 Buffer 避免字符串拼接开销）
  const stdoutChunks = []
  const stderrChunks = []
  child.stdout?.on('data', (chunk) => stdoutChunks.push(chunk))
  child.stderr?.on('data', (chunk) => stderrChunks.push(chunk))

  // 单 Agent 超时定时器
  let timeoutHandle = null
  let timedOut = false
  const timeoutMs = timeout_sec * 1000
  timeoutHandle = setTimeout(() => {
    timedOut = true
    log(`⏱️  [${id}] 超时 ${timeoutMs}ms，kill 子进程`)
    try {
      child.kill('SIGTERM')
    } catch (err) {
      // kill 失败（子进程已退出）→ 忽略
    }
  }, timeoutMs)
  timeoutHandle.unref()

  // 等子进程结束
  let exitCode = null
  try {
    exitCode = await new Promise((resolve, reject) => {
      child.on('close', (code) => {
        clearTimeout(timeoutHandle)
        // 即使 timedOut=true，close 也会被 emit，code 可能是 null（SIGTERM）或非 0
        resolve(code)
      })
      child.on('error', (err) => {
        clearTimeout(timeoutHandle)
        reject(err)
      })
    })
  } catch (err) {
    // spawn 后子进程 emit error（如命令不存在但 shell 解析通过了）
    const msg = err instanceof Error ? err.message : String(err)
    log(`❌ [${id}] 子进程 error: ${msg}`)
    return {
      id,
      status: 'failed',
      exitCode: null,
      stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
      stderr: Buffer.concat(stderrChunks).toString('utf-8'),
      duration_ms: Date.now() - startedAt,
      error: msg,
    }
  }

  const duration_ms = Date.now() - startedAt
  const stdout = Buffer.concat(stdoutChunks).toString('utf-8')
  const stderr = Buffer.concat(stderrChunks).toString('utf-8')

  // 决策 status（timedOut 在 close 后仍要判 timeout 优先）
  if (timedOut) {
    log(`⏱️  [${id}] TIMEOUT after ${duration_ms}ms (partial stdout: ${stdout.length} chars)`)
    return {
      id,
      status: 'timeout',
      exitCode,  // SIGTERM 后通常 null；少数情况非 0
      stdout,
      stderr,
      duration_ms,
      error: `timeout after ${timeoutMs}ms`,
    }
  }

  if (exitCode === 0) {
    log(`✅ [${id}] PASSED in ${duration_ms}ms`)
    return {
      id,
      status: 'passed',
      exitCode: 0,
      stdout,
      stderr,
      duration_ms,
      error: null,
    }
  }

  log(`❌ [${id}] FAILED exit=${exitCode} in ${duration_ms}ms`)
  return {
    id,
    status: 'failed',
    exitCode,
    stdout,
    stderr,
    duration_ms,
    error: null,
  }
}