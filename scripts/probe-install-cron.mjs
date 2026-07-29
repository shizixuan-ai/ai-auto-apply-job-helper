#!/usr/bin/env node
// ================================================================
// scripts/probe-install-cron.mjs — Sprint E-2 (2026-07-29)
//
// 目的: 验证 scripts/install-cron.sh 在 dry-run 模式 + flag 组合下
//       生成的 plist / crontab 字符串符合期望. 不触碰 launchctl/cron,
//       守单账号红线 (per §3.12 + §3.11 hook 不能只信).
//
// 退出码:
//   0 = OK (所有 8 场景 PASS)
//   1 = FAIL (有场景不符期望)
//
// 运行: node scripts/probe-install-cron.mjs
//
// 8 场景:
//   C1 macOS --install --dry-run  → plist XML 含 Label + StartCalendarInterval
//   C2 Linux  --install --dry-run → crontab 含 "0 9 * * 1-5" + "0 14 * * 1-5"
//   C3 macOS --uninstall --dry-run → stdout 含 "unload" + plist path
//   C4 缺 auto.yaml              → exit 1 + stderr "[INSTALL.config]"
//   C5 FEISHU_WEBHOOK_URL 已设   → plist EnvironmentVariables 含
//   C6 --phase morning only      → plist 只 1 个 StartCalendarInterval
//   C7 --hour-morning 10         → plist Hour=10
//   C8 重复跑 --install          → idempotent (第二次 stdout 包含 "覆盖" 字样)
//   C9 (E-2.5b) 项目 .env 路径   → plist EnvironmentVariables 含 url
//   C10 (E-2.5b) .env 优先        → dotenv 覆盖 shell env
// ================================================================

import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRIPT_PATH = new URL('./install-cron.sh', import.meta.url).pathname
const IS_DARWIN = process.platform === 'darwin'

// 创建一个临时 sandbox HOME, 避免污染真实 ~/.bapply/
function makeSandbox(opts = {}) {
  const sandbox = mkdtempSync(join(tmpdir(), 'probe-install-cron-'))
  const configDir = join(sandbox, '.bapply')
  mkdirSync(configDir, { recursive: true })
  // 写最小合法 auto.yaml (zod schema 接受即可)
  writeFileSync(join(configDir, 'auto.yaml'), [
    'version: 1',
    'searches: [{ keyword: "Java 后端", city: "北京", limit: 10 }]',
    'quota: { morning: 40, afternoon: 60, weekly_cap: 500 }',
    'throttle:',
    '  morning_interval_ms: [180000, 240000]',
    '  afternoon_interval_ms: [150000, 195000]',
    '  jitter_pct: 20',
    '  long_pause: { every_n_jobs: 20, duration_ms: [300000, 600000] }',
    'safety:',
    '  guard_trigger_policy: abort_day',
    '  max_failure_rate: 0.3',
    '  consecutive_guard_threshold: 3',
    '  auto_regress_warmup: true',
    '',
  ].join('\n'))
  // 写项目 .env (per E-2.5b: 敏感配置走 .env)
  if (opts.envFile !== false) {
    const envPath = join(sandbox, '.env')
    const envContent = opts.envContent ?? `# 飞书 webhook url (E-2.5b: 项目 .env 优先于 shell env)\nFEISHU_WEBHOOK_URL=https://open.feishu.cn/open-apis/bot/v2/hook/sandbox-env-url-token\n`
    writeFileSync(envPath, envContent)
  }
  // fake bapply bin
  const binDir = join(sandbox, 'fake-bin')
  mkdirSync(binDir, { recursive: true })
  const fakeBapply = join(binDir, 'bapply')
  writeFileSync(fakeBapply, '#!/bin/bash\necho "[fake bapply] $@"\nexit 0\n')
  execFileSync('chmod', ['+x', fakeBapply])
  return { sandbox, configDir, binDir, fakeBapply, envPath: join(sandbox, '.env') }
}

function runScript(args, opts = {}) {
  const env = {
    ...process.env,
    ...opts.env,
    HOME: opts.sandbox,
    PATH: `${opts.binDir}:${process.env.PATH}`,
  }
  try {
    const stdout = execFileSync('bash', [SCRIPT_PATH, ...args], {
      encoding: 'utf8',
      env,
      timeout: 15000,
      stdio: 'pipe',
      cwd: opts.cwd,  // 让脚本把 PROJECT_ROOT 指向 sandbox (覆盖真实项目根)
    })
    return { stdout, stderr: '', code: 0 }
  } catch (e) {
    return {
      stdout: e.stdout?.toString() ?? '',
      stderr: e.stderr?.toString() ?? '',
      code: e.status ?? 1,
    }
  }
}

// ===== 场景 =====
let pass = 0
let fail = 0
const fails = []

function check(label, ok, why = '') {
  if (ok) {
    pass++
    console.log(`[PASS] ${label}`)
  } else {
    fail++
    fails.push({ label, why })
    console.log(`[FAIL] ${label}: ${why}`)
  }
}

// 期望解析 plist 时的关键字段
function assertPlistField(stdout, field, value, label) {
  const ok = stdout.includes(`<key>${field}</key>`) &&
             stdout.includes(`<string>${value}</string>`)
  check(label, ok, ok ? '' : `missing <key>${field}</key><string>${value}</string>`)
}

// ================ 场景 ================
console.log('--- 10 场景验证 (sandbox HOME 隔离) ---')

// C1 macOS --install --dry-run → plist XML
{
  const sb = makeSandbox()
  const r = runScript(['--dry-run', '--phase', 'both'], {
    sandbox: sb.sandbox,
    binDir: sb.binDir,
    env: { FEISHU_WEBHOOK_URL: 'https://example.com/hook' },
  })
  if (!IS_DARWIN) {
    check('C1 macOS plist (skip non-darwin)', true, 'platform != darwin, skipped')
  } else {
    const okXml = r.stdout.includes('<?xml') && r.stdout.includes('<plist version')
    const okLabel = r.stdout.includes('<key>Label</key>') &&
                    r.stdout.includes('<string>com.boss-apply.auto</string>')
    const okInterval = r.stdout.includes('<key>StartCalendarInterval</key>')
    const okHour9 = r.stdout.includes('<key>Hour</key><integer>9</integer>')
    const okHour14 = r.stdout.includes('<key>Hour</key><integer>14</integer>')
    check(
      'C1 macOS plist XML shape',
      okXml && okLabel && okInterval && okHour9 && okHour14,
      `xml=${okXml} label=${okLabel} interval=${okInterval} h9=${okHour9} h14=${okHour14}`
    )
  }
  rmSync(sb.sandbox, { recursive: true, force: true })
}

// C2 Linux --install --dry-run → crontab
{
  const sb = makeSandbox()
  const r = runScript(['--dry-run', '--phase', 'both'], {
    sandbox: sb.sandbox,
    binDir: sb.binDir,
  })
  if (IS_DARWIN) {
    check('C2 Linux crontab (skip non-linux)', true, 'platform != linux, skipped')
  } else {
    const okMorning = r.stdout.includes('0 9 * * 1-5')
    const okAfternoon = r.stdout.includes('0 14 * * 1-5')
    const okBapply = r.stdout.includes('bapply auto')
    check(
      'C2 Linux crontab shape',
      okMorning && okAfternoon && okBapply,
      `morning=${okMorning} afternoon=${okAfternoon} bapply=${okBapply}`
    )
  }
  rmSync(sb.sandbox, { recursive: true, force: true })
}

// C3 macOS --uninstall --dry-run → unload + plist path
{
  if (!IS_DARWIN) {
    check('C3 macOS uninstall (skip non-darwin)', true, 'platform != darwin, skipped')
  } else {
    const sb = makeSandbox()
    const r = runScript(['--uninstall', '--dry-run'], {
      sandbox: sb.sandbox,
      binDir: sb.binDir,
    })
    const okUnload = r.stdout.includes('unload')
    const okPath = r.stdout.includes('com.boss-apply.auto.plist')
    check('C3 macOS uninstall --dry-run', okUnload && okPath,
          `unload=${okUnload} path=${okPath}`)
    rmSync(sb.sandbox, { recursive: true, force: true })
  }
}

// C4 缺 auto.yaml → exit 1 + stderr [INSTALL.config]
{
  const sandbox = mkdtempSync(join(tmpdir(), 'probe-install-cron-'))
  const binDir = join(sandbox, 'fake-bin')
  mkdirSync(binDir, { recursive: true })
  const r = runScript(['--dry-run'], {
    sandbox,
    binDir,
  })
  const okExit = r.code === 1
  const okMsg = r.stderr.includes('[INSTALL.config]') ||
                r.stdout.includes('[INSTALL.config]')
  check('C4 缺 auto.yaml exit 1 + [INSTALL.config]',
        okExit && okMsg, `exit=${r.code} msg=${okMsg}`)
  rmSync(sandbox, { recursive: true, force: true })
}

// C5 FEISHU_WEBHOOK_URL 已设 → plist EnvironmentVariables 含
{
  if (!IS_DARWIN) {
    check('C5 feishu env plist (skip non-darwin)', true, 'platform != darwin, skipped')
  } else {
    const sb = makeSandbox({ envFile: false })  // 不写 .env, 强制 shell env 路径
    const r = runScript(['--dry-run'], {
      sandbox: sb.sandbox,
      binDir: sb.binDir,
      cwd: sb.sandbox,
      env: { FEISHU_WEBHOOK_URL: 'https://shell-env-token-abc' },
    })
    const okEnv = r.stdout.includes('<key>EnvironmentVariables</key>') &&
                  r.stdout.includes('<key>FEISHU_WEBHOOK_URL</key>') &&
                  r.stdout.includes('<string>https://shell-env-token-abc</string>')
    check('C5 shell env → plist EnvironmentVariables',
          okEnv, `env=${okEnv}`)
    rmSync(sb.sandbox, { recursive: true, force: true })
  }
}

// C6 --phase morning only → plist 只 1 个 StartCalendarInterval
{
  if (!IS_DARWIN) {
    check('C6 phase morning only (skip non-darwin)', true, 'platform != darwin, skipped')
  } else {
    const sb = makeSandbox()
    const r = runScript(['--dry-run', '--phase', 'morning'], {
      sandbox: sb.sandbox,
      binDir: sb.binDir,
      env: { FEISHU_WEBHOOK_URL: 'https://example.com/hook' },
    })
    // 数 <key>StartCalendarInterval</key> 出现次数
    const matches = r.stdout.match(/<key>StartCalendarInterval<\/key>/g) ?? []
    const okCount = matches.length === 1
    const okHour9 = r.stdout.includes('<key>Hour</key><integer>9</integer>')
    const okNoHour14 = !r.stdout.includes('<key>Hour</key><integer>14</integer>')
    check('C6 --phase morning only',
          okCount && okHour9 && okNoHour14,
          `intervals=${matches.length} h9=${okHour9} noH14=${okNoHour14}`)
    rmSync(sb.sandbox, { recursive: true, force: true })
  }
}

// C7 --hour-morning 10 → plist Hour=10
{
  if (!IS_DARWIN) {
    check('C7 custom hour (skip non-darwin)', true, 'platform != darwin, skipped')
  } else {
    const sb = makeSandbox()
    const r = runScript(['--dry-run', '--hour-morning', '10', '--hour-afternoon', '15'], {
      sandbox: sb.sandbox,
      binDir: sb.binDir,
      env: { FEISHU_WEBHOOK_URL: 'https://example.com/hook' },
    })
    const okH10 = r.stdout.includes('<key>Hour</key><integer>10</integer>')
    const okH15 = r.stdout.includes('<key>Hour</key><integer>15</integer>')
    check('C7 --hour-morning 10 --hour-afternoon 15',
          okH10 && okH15, `h10=${okH10} h15=${okH15}`)
    rmSync(sb.sandbox, { recursive: true, force: true })
  }
}

// C8 idempotent: 重复跑 --install --dry-run stdout 包含 "已存在" / "覆盖" 字样
{
  if (!IS_DARWIN) {
    check('C8 idempotent (skip non-darwin)', true, 'platform != darwin, skipped')
  } else {
    const sb = makeSandbox({ envFile: false })  // 不写 .env, 用 shell env
    const r1 = runScript(['--dry-run'], {
      sandbox: sb.sandbox,
      binDir: sb.binDir,
      cwd: sb.sandbox,
      env: { FEISHU_WEBHOOK_URL: 'https://example.com/hook' },
    })
    const r2 = runScript(['--dry-run'], {
      sandbox: sb.sandbox,
      binDir: sb.binDir,
      cwd: sb.sandbox,
      env: { FEISHU_WEBHOOK_URL: 'https://example.com/hook' },
    })
    // 两次 stdout 内容应一致 (idempotent) 且 r2 应有 "已存在" / "覆盖" / "overwrite" 之类字样
    const okConsistent = r1.stdout === r2.stdout
    const okIdempotentHint = /已存在|覆盖|overwrite|replace|exists/i.test(r2.stdout)
    check('C8 idempotent re-run',
          okConsistent && okIdempotentHint,
          `consistent=${okConsistent} hint=${okIdempotentHint}`)
    rmSync(sb.sandbox, { recursive: true, force: true })
  }
}

// C9 (E-2.5b) 项目 .env 路径 → plist EnvironmentVariables 含 url
{
  if (!IS_DARWIN) {
    check('C9 .env 路径 (skip non-darwin)', true, 'platform != darwin, skipped')
  } else {
    const sb = makeSandbox({
      envContent: '# 飞书 webhook url (E-2.5b 验证)\nFEISHU_WEBHOOK_URL=https://dotenv-token-xyz\n',
    })
    const r = runScript(['--dry-run'], {
      sandbox: sb.sandbox,
      binDir: sb.binDir,
      cwd: sb.sandbox,  // cwd = sandbox, 脚本读 cwd/.env
      env: { FEISHU_WEBHOOK_URL: '' },  // 故意清空 shell env, 强制走 .env 路径
    })
    const okEnv = r.stdout.includes('<key>EnvironmentVariables</key>') &&
                  r.stdout.includes('<key>FEISHU_WEBHOOK_URL</key>') &&
                  r.stdout.includes('<string>https://dotenv-token-xyz</string>')
    const okHint = r.stdout.includes('INSTALL.env') || r.stderr.includes('INSTALL.env')
    check('C9 .env 路径 → plist EnvironmentVariables',
          okEnv, `env=${okEnv} hint=${okHint} | stdout-bytes=${r.stdout.length}`)
    rmSync(sb.sandbox, { recursive: true, force: true })
  }
}

// C10 (E-2.5b) .env 优先于 shell env (per 当前实现: 1. cwd/.env 先读到 → 直接覆盖)
{
  if (!IS_DARWIN) {
    check('C10 .env 优先 (skip non-darwin)', true, 'platform != darwin, skipped')
  } else {
    const sb = makeSandbox({
      envContent: 'FEISHU_WEBHOOK_URL=https://dotenv-wins\n',
    })
    const r = runScript(['--dry-run'], {
      sandbox: sb.sandbox,
      binDir: sb.binDir,
      cwd: sb.sandbox,
      env: { FEISHU_WEBHOOK_URL: 'https://shellenv-loses' },
    })
    const okDotenvWin = r.stdout.includes('<string>https://dotenv-wins</string>') &&
                        !r.stdout.includes('<string>https://shellenv-loses</string>')
    check('C10 .env 优先于 shell env',
          okDotenvWin, `dotenv-wins=${okDotenvWin}`)
    rmSync(sb.sandbox, { recursive: true, force: true })
  }
}

// ================ 摘要 ================
console.log()
console.log(`=== Total: ${pass}/${pass + fail} ===`)
if (fail > 0) {
  console.log('⚠️  FAILED:')
  for (const f of fails) console.log(`   - ${f.label}: ${f.why}`)
}
process.exit(fail === 0 ? 0 : 1)