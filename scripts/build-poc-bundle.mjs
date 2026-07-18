// ============================================================
// scripts/build-poc-bundle.mjs — Sprint 2026-07-13 PoC
// ============================================================
// esbuild 把 src/browser/boss-ws/poc-main.ts bundle 成
// dist/poc/boss-ws-poc.user.js（IIFE），前面加 Tampermonkey 元数据头。
//
// 决策 4：file:// 加载 → 输出本地 fs 路径，Tampermonkey 直接打开即可。
// ============================================================

import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(__dirname, '..')
const entry = resolve(projectRoot, 'src/browser/boss-ws/poc-main.ts')
const outDir = resolve(projectRoot, 'dist/poc')
const outFile = resolve(outDir, 'boss-ws-poc.user.js')

// Tampermonkey 元数据（决策 1 + 决策 4：file:// 加载 / 仅 chat）
const USERSCRIPT_META = `// ==UserScript==
// @name         boss-ws-poc
// @namespace    boss-apply-dev
// @version      0.1.0
// @description  PoC: hook Boss WebSocket, decode protobuf, console.log. Sprint 2026-07-13.
// @author       boss-apply dev
// @match        https://www.zhipin.com/web/geek/chat*
// @run-at       document-start
// @grant        none
// ==/UserScript==`

mkdirSync(outDir, { recursive: true })

const result = await build({
  entryPoints: [entry],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  minify: false,
  write: false,
  sourcemap: false,
})

const bundleJs = result.outputFiles[0].text

// 顶部加 Tampermonkey 元数据（IIFE 输出前加 ensure-* 一段，把 main() 在 document-start 时机调用）
const finalJs = `${USERSCRIPT_META}\n;(function () {\n${bundleJs}\n})();\n`

writeFileSync(outFile, finalJs)
console.log(`[build-poc] ok → ${outFile}`)
console.log(`[build-poc] size: ${(finalJs.length / 1024).toFixed(1)} KB`)
console.log(`[build-poc] tampermoney load path: file://${outFile}`)
