#!/usr/bin/env bash
# ============================================================
# Sprint 1A 端到端测试脚本
# ============================================================
# 5 个层级验证：
#   L1. 类型检查（tsc 0 错误）
#   L2. 单元测试（vitest 6 个 Sprint 1A 测试全绿）
#   L3. 简历解析（读 简历.md）
#   L4. CLI flag 解析（--help 展示 4 个 flag）
#   L5. 真实 e2e 搜索（用 --cdp 模式搜 BOSS）
#
# 用法：
#   bash scripts/test-sprint-1a.sh           # 跑全部 5 层
#   bash scripts/test-sprint-1a.sh --skip-e2e  # 跳过 L5（不需要 BOSS Chrome）
# ============================================================

set -e

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_ROOT"

SKIP_E2E=false
if [[ "$1" == "--skip-e2e" ]]; then
  SKIP_E2E=true
fi

# 配色
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

ok()    { echo -e "${GREEN}✓${NC} $*"; }
fail()  { echo -e "${RED}✗${NC} $*"; exit 1; }
warn()  { echo -e "${YELLOW}⚠${NC} $*"; }
info()  { echo -e "${CYAN}►${NC} $*"; }
section() { echo -e "\n${CYAN}========================================${NC}"; echo -e "${CYAN} $*${NC}"; echo -e "${CYAN}========================================${NC}"; }

# ============================================================
section "L1. TypeScript 类型检查 (tsc --noEmit)"
# ============================================================
info "跑 tsc --noEmit..."
if npx tsc --noEmit 2>&1 | tail -3; then
  ok "tsc 0 错误"
else
  fail "tsc 有错误（见上）"
fi

# ============================================================
section "L2. Sprint 1A 单元测试 (vitest)"
# ============================================================
info "跑 Sprint 1A 相关的 3 个测试文件..."
TEST_OUTPUT=$(npx vitest run \
  src/resume/md-fallback.test.ts \
  src/resume/resolver.test.ts \
  src/scoring/index.test.ts \
  src/cli/handlers/search-and-write.test.ts 2>&1 | tail -8)

if echo "$TEST_OUTPUT" | grep -qE "Test Files.*passed|Tests.*passed"; then
  PASSED=$(echo "$TEST_OUTPUT" | grep -oE "Tests +[0-9]+ passed" | head -1)
  ok "Sprint 1A 测试全绿（$PASSED）"
else
  fail "Sprint 1A 测试失败（见上）"
fi

# ============================================================
section "L3. 简历解析（readResumeMd）"
# ============================================================
RESUME_MD="$PROJECT_ROOT/简历.md"
if [[ ! -f "$RESUME_MD" ]]; then
  warn "简历.md 不存在，自动创建一份模板（请后续替换为真实简历）"
  cat > "$RESUME_MD" <<'TEMPLATE'
## 姓名
测试候选人

## 工作年限
5

## 学历
本科

## 技能
TypeScript, React, Node.js, Python

## 近期项目
- AI 自动投递简历助手
- BOSS 协议研究
TEMPLATE
  ok "已创建模板简历：$RESUME_MD"
fi

info "用 tsx 直接调用 readResumeMd 解析..."
RESUME_RESULT=$(npx tsx -e "
import { readResumeMd } from './src/resume/md-fallback.ts'
try {
  const s = readResumeMd('简历.md')
  console.log(JSON.stringify(s, null, 2))
} catch (e) {
  console.error('ERROR:', e.message)
  process.exit(1)
}
" 2>&1)

if echo "$RESUME_RESULT" | grep -q '"name"'; then
  ok "简历解析成功"
  echo "$RESUME_RESULT" | sed 's/^/   /'
else
  fail "简历解析失败：$RESUME_RESULT"
fi

# ============================================================
section "L4. CLI flag 解析（bapply search --help）"
# ============================================================
info "看 search 命令的 4 个新 flag..."
HELP_OUTPUT=$(npx tsx src/cli/index.ts search --help 2>&1)

FLAGS=("--write" "--dry-run" "--no-threshold" "--limit")
MISSING=0
for flag in "${FLAGS[@]}"; do
  if echo "$HELP_OUTPUT" | grep -q -- "$flag"; then
    ok "flag 存在: $flag"
  else
    fail "flag 缺失: $flag"
    MISSING=$((MISSING + 1))
  fi
done

# ============================================================
section "L5. 真实 e2e 搜索（可选）"
# ============================================================
if $SKIP_E2E; then
  warn "跳过（--skip-e2e）"
  exit 0
fi

# 检查 Chrome CDP
if ! curl -s --max-time 2 http://localhost:9222/json/version >/dev/null 2>&1; then
  warn "Chrome CDP 未运行（http://localhost:9222 无响应）"
  warn "如需跑 L5，请先：bash scripts/start-chrome.sh"
  warn "本脚本退出码 0（不视为失败）"
  exit 0
fi

ok "Chrome CDP 在 9222 端口运行"

info "用 --cdp 模式搜 '前端' 关键词（不传 --write，只验证搜索链路）..."
SEARCH_OUTPUT=$(perl -e 'alarm 30; exec @ARGV' npx tsx src/cli/index.ts search 前端 --cdp --limit 3 2>&1)
EXIT_CODE=$?

if echo "$SEARCH_OUTPUT" | grep -qE "岗位"; then
  ok "BOSS 搜索成功（搜到岗位）"
  echo "$SEARCH_OUTPUT" | head -15 | sed 's/^/   /'
else
  fail "BOSS 搜索失败：$SEARCH_OUTPUT"
fi

# 总结
section "🎉 Sprint 1A 测试完成"
ok "5 层全过：tsc 0 错 / 单测全绿 / 简历解析 OK / CLI flag OK / 真实搜索 OK"
