#!/usr/bin/env node
// bapply CLI wrapper — 用 tsx 跑 src/cli/index.ts（处理 ESM .ts 解析）
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const cliEntry = resolve(__dirname, '../src/cli/index.ts')

const child = spawn('npx', ['tsx', cliEntry, ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: resolve(__dirname, '..'),
  env: process.env,
})

child.on('exit', (code) => process.exit(code ?? 1))
child.on('error', (err) => {
  console.error('bapply 启动失败:', err.message)
  process.exit(1)
})