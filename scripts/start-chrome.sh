#!/usr/bin/env bash
# ============================================================
# 启动 Chrome 调试实例（CDP takeover 模式）
# ============================================================
# 用途：启动一个全新的 Chrome 实例，开启 --remote-debugging-port=9222，
#       供 probe-boss-selectors.sh / test-auto-greet.sh 通过 Playwright
#       的 chromium.connectOverCDP('http://localhost:9222') 接管。
#
# 设计取舍（2026-07-07）：
#   - 临时实例：临时 user-data-dir，登录态独立，不污染日常 Chrome
#   - 非 headless：用户要能看到窗口、手动登录 BOSS 直聘
#   - 端口固定 9222：与 scripts/probe-boss-selectors.sh:51 的硬编码探测对齐
#   - 关掉首次运行 / 默认浏览器检查：避免任何弹窗阻塞
#   - 后台 + 写 log：避免锁住当前 shell
#
# 用法：
#   bash scripts/start-chrome.sh
#
# 前置：
#   - macOS 已安装 Google Chrome（/Applications/Google Chrome.app）
#   - 9222 端口未被占用（如果已被占用，脚本会失败，让你手动选别的接管方式）
#
# 输出：
#   - 屏幕打印 webSocketDebuggerUrl + BOSS 直聘登录入口
#   - Chrome stdout/stderr 写到 /tmp/chrome-start.log
#
# 关闭方式（手动）：
#   kill $(cat /tmp/chrome-start.pid)
# ============================================================

set -euo pipefail

# ============== 配色 ==============
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

CDP_PORT="${CDP_PORT:-9222}"
PROBE_TIMEOUT_SEC="${PROBE_TIMEOUT_SEC:-15}"
LOG_FILE="${LOG_FILE:-/tmp/chrome-start.log}"
PID_FILE="${PID_FILE:-/tmp/chrome-start.pid}"
BOOTSTRAP_URL="${BOOTSTRAP_URL:-https://www.zhipin.com/}"
# 2026-07-07 audit fix: Chrome 111+ 默认拒绝跨源 WebSocket，
# Playwright 的 chromium.connectOverCDP 必须有 --remote-allow-origins=* 才连得上
# （src/browser/cdp.test.ts 的 P0 测试已绑定此契约）
REMOTE_ALLOW_ORIGINS_FLAG="--remote-allow-origins=*"

ok()   { echo -e "${GREEN}✓${NC} $1"; }
fail() { echo -e "${RED}✗${NC} $1"; }
warn() { echo -e "${YELLOW}⚠${NC} $1"; }
info() { echo -e "${BLUE}ℹ${NC} $1"; }

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# ============================================================
# Step 1: 端口占用检测
# ============================================================
if curl -sS --max-time 1 "http://localhost:${CDP_PORT}/json/version" >/dev/null 2>&1; then
  fail "端口 ${CDP_PORT} 已被占用（CDP 已就绪）"
  echo ""
  echo "两种处理方式："
  echo "  A. 如果占用的是你自己日常 Chrome："
  echo "     关闭它，用脚本接管式命令重启:"
  echo "       osascript -e 'quit app \"Google Chrome\"'"
  echo "       /Applications/\"Google Chrome.app\"/Contents/MacOS/\"Google Chrome\" --remote-debugging-port=${CDP_PORT}"
  echo "  B. 如果想换个端口："
  echo "     CDP_PORT=9333 bash scripts/start-chrome.sh  （但 probe 脚本硬编 9222，要同步改）"
  echo "  C. 直接复用现有 CDP（如果你已经在另一终端启过）："
  echo "     跳过本脚本，直接 bash scripts/probe-boss-selectors.sh <JOB_ID>"
  exit 1
fi
ok "端口 ${CDP_PORT} 未占用"

# ============================================================
# Step 2: 找 Chrome 二进制
# ============================================================
CHROME=""
CANDIDATES=(
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome-bin"
  "/usr/bin/google-chrome"
  "/usr/local/bin/google-chrome"
  "$(command -v google-chrome-stable 2>/dev/null || true)"
  "$(command -v chromium 2>/dev/null || true)"
  "$(command -v google-chrome 2>/dev/null || true)"
)

for c in "${CANDIDATES[@]}"; do
  if [[ -n "$c" && -x "$c" ]]; then
    CHROME="$c"
    break
  fi
done

if [[ -z "$CHROME" ]]; then
  fail "找不到 Chrome 可执行文件"
  echo "已尝试以下路径："
  printf '  - %s\n' "${CANDIDATES[@]}"
  echo ""
  echo "请安装 Google Chrome（推荐）：brew install --cask google-chrome"
  echo "或在脚本里补一条候选路径"
  exit 1
fi
ok "Chrome: $CHROME"

# ============================================================
# Step 3: 建临时 profile 目录
# ============================================================
PROFILE_DIR="$(mktemp -d -t chrome-cdp.XXXXXX)"
ok "临时 profile: $PROFILE_DIR"

# 异常退出 trap：清理临时 profile（含 BOSS session cookie —— 敏感数据不残留磁盘）
cleanup_on_exit() {
  local exit_code=$?
  if [[ -n "${CHROME_PID:-}" ]] && kill -0 "${CHROME_PID}" 2>/dev/null; then
    kill "${CHROME_PID}" 2>/dev/null || true
    rm -f "${PID_FILE}" 2>/dev/null || true
  fi
  if [[ -n "${PROFILE_DIR:-}" && -d "${PROFILE_DIR}" ]]; then
    rm -rf "${PROFILE_DIR}" 2>/dev/null || true
  fi
  exit "${exit_code}"
}
trap cleanup_on_exit EXIT INT TERM

# ============================================================
# Step 4: 后台拉起 Chrome
# ============================================================
# 注：不加 --headless，让用户能登录
#    --no-first-run / --no-default-browser-check 避免弹窗
#    Bootstrap URL 直接开 BOSS，登录后直接能搜
#    REMOTE_ALLOW_ORIGINS_FLAG 让 Playwright connectOverCDP 能接管（Chrome 111+ 必需）
nohup "$CHROME" \
  --remote-debugging-port="${CDP_PORT}" \
  --user-data-dir="${PROFILE_DIR}" \
  "${REMOTE_ALLOW_ORIGINS_FLAG}" \
  --no-first-run \
  --no-default-browser-check \
  --disable-background-networking \
  --disable-default-apps \
  "${BOOTSTRAP_URL}" \
  > "${LOG_FILE}" 2>&1 &

CHROME_PID=$!
echo "$CHROME_PID" > "${PID_FILE}"
ok "Chrome 启动 (pid=${CHROME_PID}, log=${LOG_FILE})"

# ============================================================
# Step 5: 轮询 CDP 就绪
# ============================================================
info "等待 CDP 就绪 (timeout ${PROBE_TIMEOUT_SEC}s)..."

# 用临时文件传 JSON（避免 command substitution subshell 吞输出 + JSON 含 \u 转义）
deadline=$(( $(date +%s) + PROBE_TIMEOUT_SEC ))
WS_URL=""
TMP_VER="$(mktemp -t cdp-version.XXXXXX.json)"
trap 'rm -f "${TMP_VER:-}"' EXIT

while [[ $(date +%s) -lt $deadline ]]; do
  # --max-time 3 容忍 Chrome accept 后第一次响应慢（带 BOSS 首页 + WebSocket warmup）
  # --silent 但失败时不丢信息（用 -w 拿 http_code 单独显示）
  http_code="$(curl -sS --max-time 3 \
    -o "${TMP_VER}" \
    -w '%{http_code}' \
    "http://localhost:${CDP_PORT}/json/version" 2>/dev/null || echo "")"
  if [[ "${http_code}" == "200" ]] && [[ -s "${TMP_VER}" ]]; then
    WS_URL=$(python3 -c "
import json, sys
try:
  with open('${TMP_VER}', 'r') as f:
    data = json.load(f)
  print(data.get('webSocketDebuggerUrl', ''))
except Exception as e:
  print('', file=sys.stderr)
" 2>/dev/null || true)
    if [[ -n "${WS_URL}" ]]; then
      break
    fi
  fi
  sleep 0.5
done

if [[ -z "$WS_URL" ]]; then
  fail "CDP ${PROBE_TIMEOUT_SEC}s 内未就绪"
  echo "Chrome 日志最后 20 行:"
  tail -20 "${LOG_FILE}" 2>/dev/null || true
  echo ""
  echo "调试建议："
  echo "  1. cat ${LOG_FILE} 看 Chrome 启动错误"
  echo "  2. kill \$(cat ${PID_FILE}) 关闭"
  exit 1
fi
ok "CDP 就绪: $WS_URL"

# ============================================================
# Step 6: 打印下一步指引
# ============================================================
echo ""
echo "═══════════════════════════════════════════════════════════════"
echo -e "${GREEN}✅ Chrome 已启动${NC}"
echo "═══════════════════════════════════════════════════════════════"
echo "  PID:          ${CHROME_PID}"
echo "  CDP:          http://localhost:${CDP_PORT}"
echo "  Profile:      ${PROFILE_DIR}"
echo "  Log:          ${LOG_FILE}"
echo "  引导页:       ${BOOTSTRAP_URL}"
echo ""
echo -e "${YELLOW}👉 现在请在 Chrome 窗口里手动登录 BOSS 直聘${NC}"
echo "   （任何手机号 + 验证码即可，约 30 秒）"
echo ""
echo "登录完成后，三个后续命令任意选一个："
echo ""
echo "  # 1. 探测当前 BOSS 页面真实选择器（用于修 src/browser/index.ts 的 JD_SELECTORS）"
echo "  bash scripts/probe-boss-selectors.sh <BOSS_JOB_ID>"
echo ""
echo "  # 2. 直接 dry-run 验证整条 auto-greet 链路（不动数据、不真发）"
echo "  bash scripts/test-auto-greet.sh 1 --dry-run"
echo ""
echo "  # 3. 跑 search 真实搜索（会自动写 BOSS_ID 到飞书）"
echo "  npx tsx src/cli/index.ts search 前端工程师 5"
echo ""
echo "═══════════════════════════════════════════════════════════════"
echo " 关闭 Chrome: kill \$(cat ${PID_FILE})"
echo " 清理临时 profile: rm -rf ${PROFILE_DIR}"
echo "═══════════════════════════════════════════════════════════════"
