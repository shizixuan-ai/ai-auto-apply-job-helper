#!/usr/bin/env bash
# ============================================================
# auto-greet 真实 BOSS 实测脚本
# ============================================================
# 用法：bash scripts/test-auto-greet.sh [limit] [--dry-run] [--quiet]
#   limit: 测试 job 数（默认 2，建议 ≤5 防风控）
#   --dry-run: 演练模式（不真实发消息、不改飞书，只生成招呼语 + 验证 LLM 输出）
#   --quiet: 禁用 ANSI 颜色（CI 友好）
#
# 流程：
#   1. 环境检查（.env、飞书表头、CLI 可执行）
#   2. 飞书链路验证（list / stats）
#   3. 单条手动 sync（不发请求，只验飞书链路）
#   4. auto-greet 小规模实测（dry-run 或真实）
#   5. 结果验证 + baseline 日志分析
#
# Dry-run vs 真实：
#   - 真实模式：向 BOSS HR 发消息 + 飞书状态改为『已投递』，需二次确认
#   - Dry-run：只调 LLM 生成招呼语，无副作用，无需二次确认
# ============================================================

set -euo pipefail

# ============== 配色 ==============
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# ============== 参数解析（位置参数：LIMIT）==============
# 默认 LIMIT=2；解析 --dry-run / --quiet 标志
LIMIT=2
DRY_RUN=false
QUIET=false
for arg in "$@"; do
  case "$arg" in
    --dry-run)
      DRY_RUN=true
      ;;
    --quiet|-q)
      QUIET=true
      ;;
    --help|-h)
      head -18 "$0" | tail -16
      exit 0
      ;;
    *)
      # 数字参数当作 limit
      if [[ "$arg" =~ ^[0-9]+$ ]]; then
        LIMIT="$arg"
      else
        echo "未知参数: $arg（支持：数字 limit / --dry-run / --quiet / --help）"
        exit 1
      fi
      ;;
  esac
done

# --quiet 模式：禁用 ANSI 颜色 + 抑制非关键输出（CI 友好）
if [[ "$QUIET" == "true" ]]; then
  RED=''; GREEN=''; YELLOW=''; BLUE=''; NC=''
fi

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASELINE_DIR="$PROJECT_ROOT/.claude/diagnose/baseline"
TODAY="$(date +%Y-%m-%d)"
BASELINE_FILE="$BASELINE_DIR/$TODAY.jsonl"

ok()   { echo -e "${GREEN}✓${NC} $1"; }
fail() { echo -e "${RED}✗${NC} $1"; }
warn() { echo -e "${YELLOW}⚠${NC} $1"; }
info() { echo -e "${BLUE}ℹ${NC} $1"; }
step() { echo -e "\n${BLUE}━━━ $1 ━━━${NC}"; }

cd "$PROJECT_ROOT"

# ============================================================
# Step 1: 环境检查
# ============================================================
step "Step 1/5 环境检查"

if [[ ! -f .env ]]; then
  fail ".env 不存在，请先 cp .env.example .env 并填值"
  exit 1
fi
ok ".env 存在"

# 检查关键环境变量
missing=()
for var in FEISHU_APP_ID FEISHU_APP_SECRET FEISHU_APP_TOKEN FEISHU_TABLE_ID LLM_PROVIDER; do
  if ! grep -q "^${var}=" .env; then
    missing+=("$var")
  fi
done

if [[ ${#missing[@]} -gt 0 ]]; then
  fail ".env 缺失变量: ${missing[*]}"
  echo "  请参考 docs/ENVIRONMENT.md 补全"
  exit 1
fi
ok "关键环境变量齐全（FEISHU_APP_ID/SECRET/TOKEN/TABLE_ID/LLM_PROVIDER）"

# LLM API key（按 provider 检查）
provider=$(grep '^LLM_PROVIDER=' .env | cut -d= -f2 | tr -d '"\047')
case "$provider" in
  deepseek)  key_var=DEEPSEEK_API_KEY ;;
  openai)    key_var=OPENAI_API_KEY ;;
  anthropic) key_var=ANTHROPIC_API_KEY ;;
  ollama)    key_var="" ;;
  *)         fail "未知 LLM_PROVIDER: $provider"; exit 1 ;;
esac

if [[ -n "$key_var" ]]; then
  if grep -q "^${key_var}=" .env; then
    ok "LLM key 存在: $key_var"
  else
    fail "LLM key 缺失: $key_var"
    exit 1
  fi
fi

# 检查 CLI 可执行
if [[ ! -f package.json ]] || ! grep -q '"bin"' package.json; then
  fail "package.json 缺 bin 配置"
  exit 1
fi
ok "package.json 正常"

# 检查 baseline 目录
mkdir -p "$BASELINE_DIR"
ok "baseline 目录: $BASELINE_DIR"

# ============================================================
# Step 2: 飞书链路验证
# ============================================================
step "Step 2/5 飞书链路验证 (bapply list)"

info "调用 bapply list..."
if npx tsx src/cli/index.ts list; then
  ok "list 命令成功（飞书读取链路通）"
else
  fail "list 失败！飞书配置可能有误（FEISHU_APP_TOKEN / FEISHU_TABLE_ID）"
  info "提示：在飞书表格 URL 中找 APP_TOKEN 和 TABLE_ID"
  info "      https://xxx.feishu.cn/base/<APP_TOKEN>?table=<TABLE_ID>"
  exit 1
fi

# ============================================================
# Step 3: stats 验证
# ============================================================
step "Step 3/5 投递统计验证 (bapply stats)"

if npx tsx src/cli/index.ts stats 2>&1 | tail -20; then
  ok "stats 命令成功"
else
  warn "stats 失败但继续（auto-greet 不依赖 stats）"
fi

# ============================================================
# Step 4: 预 dry-run：找出待投递 job 数量
# ============================================================
step "Step 4/5 准备 auto-greet (limit=$LIMIT)"

# 先读飞书，统计待投递岗位数
list_output=$(npx tsx src/cli/index.ts list 2>&1 || true)
pending_count=$(printf '%s' "$list_output" | grep -c "状态: 待投递" 2>/dev/null || true)
pending_count=${pending_count:-0}
# 清理多行（grep -c 输出可能带 trailing newlines）
pending_count=$(printf '%s' "$pending_count" | head -1 | tr -d '[:space:]')
pending_count=${pending_count:-0}
info "当前飞书『待投递』岗位数: $pending_count"

if [[ "$pending_count" == "0" ]]; then
  warn "飞书无『待投递』岗位，auto-greet 不会执行任何操作"
  info "请先用 bapply search <关键词> 搜岗位，再用 bapply send 发出去后状态变『已沟通』"
  info "或者手动在飞书表格添加『状态=待投递』的测试行"
  exit 0
fi

if [[ "$LIMIT" -gt "$pending_count" ]]; then
  warn "limit=$LIMIT 大于待投递数 $pending_count，实际只处理 $pending_count 条"
fi

# 二次确认（dry-run 模式跳过：dry-run 无副作用）
if [[ "$DRY_RUN" == "true" ]]; then
  echo ""
  info "🧪 DRY RUN 模式：只生成招呼语，不真实发送、不改飞书状态"
  info "    每条会：fetchJobDetail + LLM.generate（不会发给 BOSS HR）"
else
  echo ""
  warn "⚠️  即将调用真实 BOSS 打招呼（limit=$LIMIT 条）"
  warn "    每条会：fetchJobDetail + LLM.generate + 真实 BOSS 发送"
  warn "    失败/成功会回写飞书状态"
  echo ""
  read -p "继续？[y/N] " -n 1 -r
  echo
  if [[ ! "$REPLY" =~ ^[Yy]$ ]]; then
    info "用户取消，未执行 auto-greet"
    exit 0
  fi
fi

# 记录 baseline 时间锚点
start_time=$(date +%s)
start_iso=$(date -u +%Y-%m-%dT%H:%M:%SZ)
info "开始时间: $start_iso"

# ============================================================
# Step 5: 实际跑 auto-greet
# ============================================================
step "Step 5/5 auto-greet 实战 (limit=$LIMIT$([ "$DRY_RUN" == "true" ] && echo " --dry-run"))"

# 组装 sync 命令（dry-run 时加 --dry-run）
SYNC_ARGS=(sync --auto-greet --limit "$LIMIT")
if [[ "$DRY_RUN" == "true" ]]; then
  SYNC_ARGS+=(--dry-run)
fi

if npx tsx src/cli/index.ts "${SYNC_ARGS[@]}"; then
  ok "auto-greet 命令退出码 0"
else
  exit_code=$?
  warn "auto-greet 退出码: $exit_code（部分成功是预期行为，详见输出）"
fi

# ============================================================
# 事后分析：baseline + 飞书对比
# ============================================================
step "事后分析"

end_time=$(date +%s)
duration=$((end_time - start_time))
info "耗时: ${duration}s"

# Baseline 日志（默认空串，避免 set -u 报错）
if [[ -n "${BASELINE_FILE:-}" && -f "${BASELINE_FILE}" ]]; then
  info "本次 baseline 记录（${BASELINE_FILE}）："
  awk -v start="$start_iso" '
    $0 ~ start,/^$/ {print}
  ' "${BASELINE_FILE}" 2>/dev/null | tail -20 || tail -10 "${BASELINE_FILE}"
else
  warn "未找到今日 baseline 文件"
fi

# 飞书状态对比
echo ""
info "飞书最新状态分布:"
npx tsx src/cli/index.ts stats 2>&1 | tail -15 || true

echo ""
if [[ "$DRY_RUN" == "true" ]]; then
  ok "Dry-run 完成！请按以下清单核对："
  echo "  [ ] 1. 输出包含『DRY RUN』横幅"
  echo "  [ ] 2. 每条招呼语都展示了完整内容（人工 review 质量）"
  echo "  [ ] 3. 飞书状态未变（仍是『待投递』）"
  echo "  [ ] 4. 没有 BOSS 风控风险"
  echo ""
  info "确认招呼语质量后，可跑真实模式："
  echo "  bash scripts/test-auto-greet.sh $LIMIT"
else
  ok "实测完成！请按以下清单核对："
  echo "  [ ] 1. auto-greet 输出 succeeded/failed 数字合理"
  echo "  [ ] 2. 飞书对应 record 状态变为『已投递』"
  echo "  [ ] 3. BOSS 端 HR 收到打招呼消息（人工验证）"
  echo "  [ ] 4. LLM 生成的招呼语质量（人工 review）"
  echo "  [ ] 5. baseline 日志无 http_code 异常"
  echo ""
  info "如需排查："
  echo "  cat $BASELINE_FILE | tail -20"
  echo "  bash scripts/test-auto-greet.sh  # 重跑"
fi