#!/usr/bin/env node
// ================================================================
// scripts/cli-commands-smoke.mjs — Sprint E-1f (2026-07-29)
//
// 目的: 用 --help 触发 commander 注册链路, 验证所有 command 注册无冲突.
//       (per D-1c 教训: 561 vitest PASS 但 commander 冲突无人发现)
//
// 退出码:
//   0 = OK (所有命令注册成功)
//   1 = FAIL (有命令注册失败 / D-1c 类型冲突)
//
// 运行: node scripts/cli-commands-smoke.mjs
// 后续: 加进 CI / smoke:cli (per §3.11 hook 不能只信)
// ================================================================

import { execSync } from 'node:child_process'

// [顶层命令, 子命令(可空), 子子命令(可空)]  → 完整命令拼接
// 'bapply' 由 commander bin 替换为 npx tsx src/cli/index.ts 真实路径
const COMMANDS = [
  { cmd: ['--help'], label: 'bapply --help', expect: 'top-level help' },
  { cmd: ['init', '--help'], label: 'init --help' },
  { cmd: ['login', '--help'], label: 'login --help' },
  { cmd: ['search', '--help'], label: 'search --help' },
  { cmd: ['greet', '--help'], label: 'greet --help' },
  { cmd: ['send', '--help'], label: 'send --help' },
  { cmd: ['list', '--help'], label: 'list --help' },
  { cmd: ['sync', '--help'], label: 'sync --help' },
  { cmd: ['stats', '--help'], label: 'stats --help' },
  { cmd: ['chrome', '--help'], label: 'chrome --help' },
  { cmd: ['auto', '--help'], label: 'auto --help' },
  { cmd: ['auto', 'init-config', '--help'], label: 'auto init-config --help' },
]

const BIN = 'npx tsx src/cli/index.ts'
let pass = 0
let fail = 0
const fails = []

for (const { cmd, label } of COMMANDS) {
  const full = `${BIN} ${cmd.join(' ')}`
  try {
    const stdout = execSync(full, {
      encoding: 'utf8',
      timeout: 20000,
      stdio: 'pipe',
      cwd: process.cwd(),
    })
    // commander --help 应输出 Usage + Options, 不应 throw
    if (!stdout.includes('Usage:') && !stdout.includes('help')) {
      fail++
      fails.push({ label, why: 'no Usage: line in output' })
      console.log(`[FAIL] ${label}: missing Usage: line`)
      continue
    }
    pass++
    console.log(`[PASS] ${label}`)
  } catch (e) {
    fail++
    fails.push({
      label,
      stderr: e.stderr?.toString().slice(0, 300) ?? e.message,
    })
    console.log(`[FAIL] ${label}`)
    console.log(`        ${(e.stderr ?? e.message ?? '').toString().slice(0, 300)}`)
  }
}

console.log()
console.log(`=== Total: ${pass}/${COMMANDS.length} commander registration PASS ===`)
if (fail > 0) {
  console.log('⚠️  FAILED commands (likely D-1c 类冲突):')
  for (const f of fails) console.log(`   - ${f.label}: ${f.stderr ?? f.why}`)
}
process.exit(fail === 0 ? 0 : 1)
