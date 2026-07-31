// ============================================================
// install-cron.test.ts — Sprint E-3.x — Q1 A + Q10 A 决策
// ============================================================
// 行为契约 (per grill-me Q1 A + Q10 A):
//   - build_crontab_linux 输出 crontab line 含 "cd ${PROJECT_ROOT} && bapply auto" 前置
//   - macOS plist 含 <key>WorkingDirectory</key><string>${PROJECT_ROOT}</string>
//   - 与 T11 (config-loader cwd 相对) + T12 (init-config cwd 相对) 模式一致
//   - cron 启动时 cwd = projectRoot → auto 找 ./auto.yaml 找到 (Q5 A)
//
// TDD 状态: RED (src 未改, build_crontab_linux 没 cd && 前置, plist 没 WorkingDirectory)

import { describe, it, expect } from 'vitest'
import { execSync } from 'node:child_process'
import * as path from 'node:path'

const SCRIPT_PATH = path.resolve(__dirname, '../../scripts/install-cron.sh')

describe('build_crontab_linux — Q1 A + Q10 A 决策', () => {
  // P0 fix: strip ANSI escape codes (脚本初始化 info() / ok() 输出带 [0;34m 等色码)
  const stripAnsi = (s: string) => s.replace(/\[[0-9;]*m/g, '')

  it('T16: crontab line 含 "cd ${PROJECT_ROOT} && bapply auto" 前置', () => {
    // source install-cron.sh + 设环境变量 + 调 build_crontab_linux
    const rawOutput = execSync(
      `bash -c 'source ${SCRIPT_PATH}; PHASE=morning MINUTE_MORNING=30 HOUR_MORNING=10 BAPPLY_PATH=/usr/bin/bapply PROJECT_ROOT=/Users/test/project build_crontab_linux'`,
      { encoding: 'utf8', shell: '/bin/bash' },
    )
    const output = stripAnsi(rawOutput)
    // 断言: cron line 含 "cd <projectRoot>" + "&&" + "bapply auto"
    if (!/cd "\/Users\/test\/project" && \/usr\/bin\/bapply auto/.test(output)) {
      throw new Error(`[T16 DEBUG output]\n${output}`)
    }
  })

  // P1 fix: T16b afternoon phase 覆盖
  it('T16b: afternoon phase crontab 也含 cd && 前置 (P1 覆盖)', () => {
    const rawOutput = execSync(
      `bash -c 'source ${SCRIPT_PATH}; PHASE=afternoon MINUTE_AFTERNOON=30 HOUR_AFTERNOON=14 BAPPLY_PATH=/usr/bin/bapply PROJECT_ROOT=/Users/test/project build_crontab_linux'`,
      { encoding: 'utf8', shell: '/bin/bash' },
    )
    const output = stripAnsi(rawOutput)
    if (!/cd "\/Users\/test\/project" && \/usr\/bin\/bapply auto --phase afternoon/.test(output)) {
      throw new Error(`[T16b DEBUG output]\n${output}`)
    }
  })

  it('T17: plist 含 <key>WorkingDirectory</key><string>${PROJECT_ROOT}</string>', () => {
    // source install-cron.sh + 调 build_plist_macos + 提取 PLIST_CONTENT
    const rawOutput = execSync(
      `bash -c 'source ${SCRIPT_PATH}; PHASE=morning MINUTE_MORNING=30 HOUR_MORNING=10 BAPPLY_PATH=/usr/bin/bapply PROJECT_ROOT=/Users/test/project PLIST_LABEL=com.test.bapply PLIST_PATH=/tmp/test.plist LOGS_DIR=/tmp/logs build_plist_macos'`,
      { encoding: 'utf8', shell: '/bin/bash' },
    )
    const output = stripAnsi(rawOutput)
    // 断言: plist 含 WorkingDirectory key + projectRoot value
    if (!/<key>WorkingDirectory<\/key>/.test(output)) {
      throw new Error(`[T17 DEBUG no WorkingDirectory]\n${output}`)
    }
    if (!/<string>\/Users\/test\/project<\/string>/.test(output)) {
      throw new Error(`[T17 DEBUG no projectRoot value]\n${output}`)
    }
  })
})
