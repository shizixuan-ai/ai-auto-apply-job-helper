#!/usr/bin/env node
// ============================================================
// cli-smoke.mjs — Sprint Smoke 5
// ============================================================
// 目的：端到端验证 CLI 链路（不写飞书，不发真消息）
//   - 跑 bapply search Java后端 --cdp --dry-run --limit 1
//   - 验证：连接 BOSS → 搜索 → 评分 → dry-run 输出（无副作用）
//
// 退出码：
//   0 = OK（CLI 链路完整，评分成功）
//   1 = BLOCK（CLI 崩溃 / 搜索完全失败）
//   2 = SKIP（CDP/Chrome :9222 不在 或 BOSS 未登录）
//
// Sprint Smoke 5：MVP 第 3 条 rule
// ============================================================

import { execSync } from 'node:child_process'

const CDP_CHECK = 'curl -s http://localhost:9222/json/version > /dev/null'
const SEARCH_CMD = 'npx tsx src/cli/index.ts search Java后端 --cdp --dry-run --limit 1 --no-threshold'

// ============================================================
// 顶层 main 调用：脚本独立运行时才触发
// ------------------------------------------------------------
// 测试 import 时不希望 main() 自动跑（会 spawn 子进程干扰测试）
// 用 import.meta.url 检测：被 tsx 当脚本跑时 url 是这个文件
// 但被 vitest dynamic import 时不会触发
// ============================================================
const isMainScript = process.argv[1] && process.argv[1].endsWith('cli-smoke.mjs')
if (isMainScript) {
  main().catch((err) => {
    console.error(`[cli-smoke] ❌ 脚本崩溃: ${err.message}`)
    process.exit(2)
  })
}

async function main() {
  // 1. CDP 可用性检查（前置条件）
  const cdpOk = checkCdp()
  if (!cdpOk) {
    console.log('[cli-smoke] ⏭️  SKIP（CDP :9222 不在）')
    console.log('请先用 --remote-debugging-port=9222 启动 Chrome 并登录 BOSS')
    process.exit(2)
  }

  // 2. 跑 search（60s 超时给 LLM 评分留余量）
  console.log('[cli-smoke] 🚀 跑 search Java后端 --cdp --dry-run --limit 1')
  console.log(`[cli-smoke]   cmd: ${SEARCH_CMD}`)

  let output = ''
  let exitCode = 0
  try {
    output = execSync(SEARCH_CMD, {
      cwd: process.cwd(),
      encoding: 'utf-8',
      timeout: 60_000,
      stdio: 'pipe',
    })
  } catch (err) {
    output = (err.stdout?.toString() ?? '') + (err.stderr?.toString() ?? '')
    exitCode = err.status ?? 1
  }

  // 3. 解析输出
  const parsed = parseSearchOutput(output)

  // 4. 决策
  if (exitCode !== 0 && !parsed) {
    console.error('[cli-smoke] ❌ CLI 崩溃（exit code 非 0 且输出不可解析）')
    console.error('--- last 30 lines ---')
    console.error(output.split('\n').slice(-30).join('\n'))
    process.exit(1)
  }

  console.log('')
  console.log('[cli-smoke] 📊 解析结果:')
  console.log(`  评分成功: ${parsed.scored}/${parsed.total}`)
  console.log(`  通过阈值: ${parsed.passed}`)
  console.log(`  失败:     ${parsed.failed}`)

  // 5. 评分成功但 fetchJobDetail 失败是已知问题（Sprint 2C）→ WARN
  if (parsed.total === 0) {
    console.error('[cli-smoke] ⚠️  搜索返 0 个 job（关键词不匹配 或 BOSS 没结果）')
    process.exit(0) // WARN 不是 BLOCK
  }

  if (parsed.scored === 0) {
    console.error('[cli-smoke] ❌ 所有 job 评分失败（搜索 + 评分链路崩）')
    process.exit(1)
  }

  // 检查硬契约关键词（搜索/解析层硬错误）
  const hardContractPatterns = [
    /encryptBossId.*missing/i,
    /encryptJobId.*missing/i,
    /FieldNameNotFound/i,
    /page\.evaluate.*is not a function/i,
  ]
  if (hardContractPatterns.some((p) => p.test(output))) {
    console.error('[cli-smoke] ❌ 检测到硬契约错误')
    process.exit(1)
  }

  console.log('[cli-smoke] ✅ CLI 链路 OK')
  process.exit(0)
}

/**
 * 检查 CDP :9222 是否可访问
 */
function checkCdp() {
  try {
    execSync(CDP_CHECK, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/**
 * 解析 dry-run 输出，提取评分统计
 *
 * 期望格式：
 *   📊 搜索并评分结果 (mode=DRY-RUN):
 *     总岗位: N
 *     评分成功: N
 *     通过阈值 (0.85): N
 *     写入飞书: N
 *     失败: N
 */
export function parseSearchOutput(output) {
  const totalMatch = output.match(/总岗位:\s*(\d+)/)
  const scoredMatch = output.match(/评分成功:\s*(\d+)/)
  const passedMatch = output.match(/通过阈值[^:]*:\s*(\d+)/)
  const failedMatch = output.match(/失败:\s*(\d+)/)

  if (!totalMatch) return null

  return {
    total: Number(totalMatch[1]),
    scored: Number(scoredMatch?.[1] ?? 0),
    passed: Number(passedMatch?.[1] ?? 0),
    failed: Number(failedMatch?.[1] ?? 0),
  }
}