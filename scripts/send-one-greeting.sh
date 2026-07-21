#!/usr/bin/env bash
# ============================================================
# send-one-greeting.sh — 一站式"打招呼"流水线
# ============================================================
# 流程：init → login → search(写飞书) → 从飞书查最新 pending → send
# 设计原则：
#   1. 各 bapply 子命令已独立测试，本脚本只做编排
#   2. 飞书是状态枢纽：search 写入后从飞书查 recordId/lid/securityId
#   3. 使用 BOSS 默认招呼语（send 不传 message，走 BOSS friend/add 默认行为）
#   4. 失败立即退出（set -e），不静默继续
#   5. --dry-run 模式：search 走 dry-run，不真发 send
#   6. 每次运行前提示，避免误操作
# ============================================================
# 用法：
#   ./scripts/send-one-greeting.sh [关键词，默认"前端开发"]
#   ./scripts/send-one-greeting.sh --dry-run [关键词]
#   ./scripts/send-one-greeting.sh --yes [关键词]   # 跳过确认
# ============================================================

set -euo pipefail

# ============================================================
# 0. 参数解析
# ============================================================

DRY_RUN=false
SKIP_CONFIRM=false
KEYWORD="前端开发"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    --yes|-y)  SKIP_CONFIRM=true; shift ;;
    -h|--help)
      grep '^#' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *)
      KEYWORD="$1"; shift ;;
  esac
done

# ============================================================
# 1. 路径 / 工具检查
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

if ! command -v jq >/dev/null 2>&1; then
  echo "❌ 缺少 jq，请先安装：brew install jq" >&2
  exit 1
fi

# 颜色（如果 stdout 不是 tty 则禁用）
if [[ -t 1 ]]; then
  C_CYAN='\033[36m'
  C_GREEN='\033[32m'
  C_YELLOW='\033[33m'
  C_RED='\033[31m'
  C_RESET='\033[0m'
else
  C_CYAN=''; C_GREEN=''; C_YELLOW=''; C_RED=''; C_RESET=''
fi

step() { echo -e "\n${C_CYAN}═══ [$1/$2] $3 ═══${C_RESET}"; }
ok()   { echo -e "${C_GREEN}✅ $1${C_RESET}"; }
warn() { echo -e "${C_YELLOW}⚠️  $1${C_RESET}"; }
err()  { echo -e "${C_RED}❌ $1${C_RESET}" >&2; }

TOTAL=5
[[ "$DRY_RUN" == "true" ]] && TOTAL=4  # dry-run 跳过 send

# ============================================================
# 2. 执行流水线
# ============================================================

echo -e "${C_CYAN}🚀 一站式打招呼流水线${C_RESET}"
echo -e "   关键词: ${C_YELLOW}$KEYWORD${C_RESET}"
echo -e "   模式:   ${C_YELLOW}$([ "$DRY_RUN" == "true" ] && echo "DRY-RUN（不真发）" || echo "REAL（真发 BOSS）")${C_RESET}"
echo

if [[ "$SKIP_CONFIRM" != "true" ]]; then
  read -rp "继续？[y/N] " ans
  [[ "$ans" =~ ^[Yy]$ ]] || { echo "已取消"; exit 0; }
fi

# --- 步骤 1: init ---
step 1 $TOTAL "init（环境检查）"
npx tsx src/cli/index.ts init

# --- 步骤 2: login ---
step 2 $TOTAL "login（验证 BOSS session）"
npx tsx src/cli/index.ts login

# --- 步骤 3: search ---
step 3 $TOTAL "search --write --limit 1（搜 1 个高分岗位并写飞书）"
SEARCH_FLAGS=(--write --limit 1)
[[ "$DRY_RUN" == "true" ]] && SEARCH_FLAGS+=(--dry-run)
npx tsx src/cli/index.ts search "$KEYWORD" "${SEARCH_FLAGS[@]}"

# --- 步骤 4: 从飞书查最新 pending 记录 ---
step 4 $TOTAL "从飞书查最新待发送记录"
PENDING_JSON=$(npx tsx -e '
import "dotenv/config";
import { loadConfig } from "./src/config/index.js";
import { listRecords } from "./src/feishu/index.js";
const cfg = loadConfig();
const resp = await listRecords(cfg.feishu.appToken, cfg.feishu.tableId, 50);
const items = resp?.data?.items ?? resp?.items ?? [];
const pending = items
  .filter(r => r.fields?.["打招呼状态"] === "待发送")
  .sort((a, b) => String(b.record_id).localeCompare(String(a.record_id)))[0];
if (!pending) { console.error("no_pending"); process.exit(2); }
const f = pending.fields ?? {};
console.log(JSON.stringify({
  jobId:       f.JOB_ID ?? f.encryptJobId ?? "",
  lid:         f.LID ?? "",
  securityId:  f.SECURITY_ID ?? "",
  recordId:    pending.record_id,
  title:       f.职位 ?? f.["职位名称"] ?? "",
  company:     f.公司 ?? f.["公司"] ?? "",
}));
')

JOB_ID=$(echo       "$PENDING_JSON" | jq -r '.jobId')
LID=$(echo          "$PENDING_JSON" | jq -r '.lid')
SECURITY_ID=$(echo  "$PENDING_JSON" | jq -r '.securityId')
RECORD_ID=$(echo    "$PENDING_JSON" | jq -r '.recordId')
TITLE=$(echo        "$PENDING_JSON" | jq -r '.title')
COMPANY=$(echo      "$PENDING_JSON" | jq -r '.company')

ok "找到待发送记录：$TITLE @ $COMPANY"
echo "   jobId:      $JOB_ID"
echo "   lid:        $LID"
echo "   securityId: ${SECURITY_ID:0:8}****"
echo "   recordId:   $RECORD_ID"

# --- 步骤 5: send（仅 REAL 模式） ---
if [[ "$DRY_RUN" == "true" ]]; then
  step 5 $TOTAL "send（DRY-RUN 跳过）"
  warn "DRY-RUN 模式：不调 bapply send。上面已打印待发送 job 信息，可手动验证后再跑真实模式。"
  exit 0
fi

step 5 $TOTAL "send（真发 BOSS 默认招呼语）"
if [[ "$SKIP_CONFIRM" != "true" ]]; then
  read -rp "确认发送？[y/N] " ans
  [[ "$ans" =~ ^[Yy]$ ]] || { echo "已取消（飞书记录仍是 pending，可手动重发或清理）"; exit 0; }
fi

npx tsx src/cli/index.ts send "$JOB_ID" --lid "$LID" --security-id "$SECURITY_ID" --record-id "$RECORD_ID"

ok "🎉 发送完成"
