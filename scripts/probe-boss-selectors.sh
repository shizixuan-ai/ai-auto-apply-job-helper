#!/usr/bin/env bash
# ============================================================
# BOSS 直聘选择器探测脚本（诊断 BOSS 前端改版）
# ============================================================
# 用法：
#   1. 先用 CDP 模式启动 Chrome（已有的话可跳过）：
#      bash scripts/start-chrome.sh   # 启动 --remote-debugging-port=9222 的 Chrome
#   2. 浏览器登录 BOSS 直聘
#   3. 跑探测脚本（指定一个真实 job_id）：
#      bash scripts/probe-boss-selectors.sh <BOSS_JOB_ID>
#
# 脚本会：
#   - 连接 CDP Chrome（接管模式）
#   - 打开 https://www.zhipin.com/job_detail/{BOSS_JOB_ID}.html
#   - dump 页面所有可能是 JD 容器的元素（class 名 + 文本长度 + 子元素数）
#   - 输出按"文本长度"排序的候选列表
#   - 输出每个候选选择器的 CSS selector
#
# 用户根据输出，把命中的选择器复制到 src/browser/index.ts 的 JD_SELECTORS 数组
# ============================================================

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

if [[ $# -lt 1 ]]; then
  echo -e "${RED}用法：$0 <BOSS_JOB_ID>${NC}"
  echo "  示例：$0 7b3a8f9d1c2e4f5g6h7i8j9k0l"  # BOSS encryptJobId
  echo ""
  echo "如何获取 BOSS_JOB_ID："
  echo "  1. 在浏览器打开 BOSS 任意岗位页"
  echo "  2. URL 形如 https://www.zhipin.com/job_detail/XXXX.html"
  echo "  3. XXXX 就是 BOSS_JOB_ID"
  exit 1
fi

JOB_ID="$1"
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROBE_SCRIPT="$PROJECT_ROOT/scripts/_probe-boss-page.mjs"

ok()   { echo -e "${GREEN}✓${NC} $1"; }
fail() { echo -e "${RED}✗${NC} $1"; }
warn() { echo -e "${YELLOW}⚠${NC} $1"; }
info() { echo -e "${BLUE}ℹ${NC} $1"; }

# 检查 Chrome 是否在 9222 端口运行
if ! curl -sS http://localhost:9222/json/version >/dev/null 2>&1; then
  fail "Chrome 调试端口 9222 未启动"
  echo ""
  echo "请先用 CDP 模式启动 Chrome："
  echo "  bash scripts/start-chrome.sh"
  exit 1
fi
ok "Chrome CDP 端口 9222 可达"

# 写一个临时探测脚本（用 Playwright via CDP 接管）
cat > "$PROBE_SCRIPT" <<'EOF'
import { chromium } from 'playwright'

const JOB_ID = process.argv[2]
if (!JOB_ID) {
  console.error('需要 BOSS_JOB_ID 参数')
  process.exit(1)
}

const browser = await chromium.connectOverCDP('http://localhost:9222')
const context = browser.contexts()[0]
if (!context) {
  console.error('未找到浏览器 context')
  process.exit(1)
}
// 2026-07-07 fix：用 pages() 里「含 zhipin」的 tab（已登录），不要 newPage() —— 否则新 tab 没 cookie，
// BOSS 会跳到 _security_check 并销毁 execution context
const existingPages = context.pages()
let page = existingPages.find(p => (p.url() || '').includes('zhipin'))
if (!page) {
  console.error('未找到已打开的 BOSS tab')
  console.error('   请在 Chrome 窗口里至少开一次 https://www.zhipin.com 后再跑本脚本')
  console.error('   现有 tabs:')
  for (const p of existingPages) console.error(`     - ${p.url()}`)
  process.exit(1)
}

const url = `https://www.zhipin.com/job_detail/${JOB_ID}.html`
console.log(`\n打开: ${url}\n`)
console.log(`已登录 tab: ${page.url().slice(0, 80)}\n`)
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })

// 给 BOSS 反爬留 3 秒缓冲（含可能的 _security_check 一次性验证）
await page.waitForTimeout(3000)

// 检查是否被重定向（登录失效 / 风控）
if (page.url().includes('/user/') || page.url() === 'about:blank') {
  console.error('页面被重定向到登录页，请确保 Chrome 已登录 BOSS')
  process.exit(1)
}
if (page.url().includes('_security_check=') || page.url().includes('/web/geek/security/')) {
  console.error('⚠️  触发 BOSS 安全验证（_security_check）')
  console.error('    请在 Chrome 窗口手动完成验证（拖动滑块/点击确认），完成后重新跑本脚本')
  console.error(`    当前 URL: ${page.url()}`)
  process.exit(2)
}

// 探测 JD 容器候选元素
const candidates = await page.evaluate(() => {
  // 候选选择器列表（与 src/browser/index.ts 同步）
  const selectors = [
    '.job-sec-text',
    '.job-detail-section',
    '.job-intro-container',
    '.text-desc',
    '[class*="job-sec"]',
    '[class*="job-detail"]',
    '[class*="job-intro"]',
    '[class*="description"]',
    'main',
    'article',
  ]

  const results = []
  for (const sel of selectors) {
    const els = Array.from(document.querySelectorAll(sel))
    for (const el of els) {
      const text = (el.textContent ?? '').trim()
      results.push({
        selector: sel,
        tag: el.tagName.toLowerCase(),
        className: el.className || '(empty)',
        textLength: text.length,
        childCount: el.children.length,
        preview: text.slice(0, 80).replace(/\s+/g, ' '),
      })
    }
  }
  // 按文本长度倒序
  results.sort((a, b) => b.textLength - a.textLength)
  return results
})

// 输出
console.log(`发现 ${candidates.length} 个候选元素（按文本长度排序）：\n`)
console.log('选择器'.padEnd(35), '类名'.padEnd(35), '文本长度'.padStart(10), '  子元素  预览')
console.log('─'.repeat(120))
for (const c of candidates.slice(0, 25)) {
  console.log(
    c.selector.padEnd(35),
    String(c.className).slice(0, 33).padEnd(35),
    String(c.textLength).padStart(10),
    '  ',
    String(c.childCount).padStart(3),
    '  ',
    c.preview,
  )
}

console.log('\n使用建议：')
console.log('  1. 找文本长度 500+ 且是 .job-* 类的选择器')
console.log('  2. 把那个选择器加到 src/browser/index.ts 的 JD_SELECTORS 数组最前面')
console.log('  3. 跑测试验证: npx vitest run src/browser/index.test.ts')
console.log('  4. 跑 dry-run 端到端: bash scripts/test-auto-greet.sh 1 --dry-run')

// 2026-07-07 fix：不要 await browser.close() —— 否则 Playwright 会关掉所有 CDP tab，
//    包括用户已登录的 Chrome 实例。改用 connectOverCDP 模式的非破坏性退出。
process.exit(0)
EOF

# 跑探测脚本
cd "$PROJECT_ROOT"
node "$PROBE_SCRIPT" "$JOB_ID"

# 清理
rm -f "$PROBE_SCRIPT"
ok "探测完成"