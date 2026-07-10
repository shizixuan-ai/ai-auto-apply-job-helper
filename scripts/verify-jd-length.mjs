#!/usr/bin/env node
// ============================================================
// verify-jd-length.mjs — Smoke Rule #4 (ADR-0004 decision 4)
// ============================================================
// 目的：验证 scored jobs 的 JD textLength ≥ MIN_JD_LENGTH_THRESHOLD
//   - 跑 bapply search Java后端 --cdp --dry-run --limit 3
//   - 解析每条 scored job 的 textLength 字段
//   - 任何 < MIN_JD_LENGTH_THRESHOLD 的视为"懒加载假绿" → FAIL
//
// 退出码：
//   0 = PASS（所有 scored jobs JD ≥ 阈值）
//   1 = BLOCK（存在短 JD 或 spawn 失败）
//   2 = SKIP（CDP/Chrome :9222 不可达）
//
// 关联 ADR-0004 decision 4：smoke rule #4
// ============================================================

import { spawnSync } from 'node:child_process'

const MIN_JD_LENGTH = Number(process.env.MIN_JD_LENGTH_THRESHOLD ?? 500)
const CDP_URL = 'http://127.0.0.1:9222/json/version'
const SEARCH_CMD = 'npx tsx src/cli/index.ts search Java后端 --cdp --dry-run --limit 3'
const TIMEOUT_MS = 60_000

// ============================================================
// 顶层 main 调用：脚本独立运行时才触发
// ------------------------------------------------------------
// 测试 import 时不希望 main() 自动跑（会 spawn 子进程干扰测试）
// 用 import.meta.url 检测：被 tsx 当脚本跑时 url 是这个文件
// 但被 vitest dynamic import 时不会触发
// ============================================================
const isMainScript = process.argv[1] && process.argv[1].endsWith('verify-jd-length.mjs')
if (isMainScript) {
  main().catch((err) => {
    console.error(`[verify-jd-length] ❌ 脚本崩溃: ${err.message}`)
    process.exit(2)
  })
}

async function main() {
  // 1. CDP 可达性检测（独立 fetch，2s 超时）
  let cdpReachable = false
  try {
    const resp = await fetch(CDP_URL, { signal: AbortSignal.timeout(2000) })
    cdpReachable = resp.ok
  } catch {
    cdpReachable = false
  }

  if (!cdpReachable) {
    console.log('[verify-jd-length] CDP :9222 不可达 → SKIP')
    process.exit(2) // smoke rule #4 skip
  }
  console.log('[verify-jd-length] CDP 可达 ✓')

  // 2. 跑 bapply search 子进程
  console.log(`[verify-jd-length] 🚀 跑 search Java后端 --cdp --dry-run --limit 3`)
  console.log(`[verify-jd-length]   cmd: ${SEARCH_CMD}`)

  const result = spawnSync(SEARCH_CMD, {
    shell: true,
    stdio: 'pipe',
    encoding: 'utf-8',
    timeout: TIMEOUT_MS,
    env: { ...process.env },
  })

  const output = (result.stdout ?? '') + (result.stderr ?? '')
  const exitCode = result.status ?? 1

  // 3. 解析 scored jobs 的 JD textLength
  //    MVP: 通用正则 /textLength[=:]\s*(\d+)/gi 提取所有数字
  const lengths = parseLengths(output)

  // 4. 判定
  const shortJobs = lengths.filter((len) => len < MIN_JD_LENGTH)
  const ok = exitCode === 0 && shortJobs.length === 0

  console.log(`[verify-jd-length] checked ${lengths.length} jobs, MIN_JD_LENGTH = ${MIN_JD_LENGTH}`)
  console.log(`[verify-jd-length] result: ${ok ? 'PASS' : 'FAIL'}`)
  if (lengths.length > 0) {
    console.log('[verify-jd-length] job textLengths:')
    lengths.forEach((len, i) => {
      console.log(`  job${i + 1}: ${len}${len < MIN_JD_LENGTH ? ' ⚠️ < ' + MIN_JD_LENGTH : ' ✓'}`)
    })
  }

  if (shortJobs.length > 0) {
    console.error(
      `[verify-jd-length] ❌ ${shortJobs.length} jobs have JD < ${MIN_JD_LENGTH}（懒加载假绿）`,
    )
    console.error('[verify-jd-length] 见 LazyLoadError 堆栈或 console.warn 日志')
  }

  if (exitCode !== 0) {
    console.error(`[verify-jd-length] ❌ search 子进程 exit code = ${exitCode}`)
  }

  process.exit(ok ? 0 : 1)
}

/**
 * 从 dry-run 输出中提取所有 scored job 的 textLength 数字
 *
 * 期望匹配模式（任一即可）：
 *   - textLength=500
 *   - textLength: 800
 *   - textLength 600
 *
 * @param {string} output bapply search --dry-run 的 stdout+stderr
 * @returns {number[]} 所有匹配到的 textLength，按出现顺序
 */
export function parseLengths(output) {
  const lengthMatches = [...output.matchAll(/textLength[=:]\s*(\d+)/gi)]
  return lengthMatches.map((m) => Number(m[1]))
}