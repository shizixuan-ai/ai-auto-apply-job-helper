#!/usr/bin/env bash
# ============================================================
# 飞书多维表格初始化脚本
# ============================================================
# 用法：bash scripts/init-feishu.sh [test_row_count]
#   test_row_count: 添加多少行『待投递』测试数据（默认 3）
#
# 前置条件：
#   1. 已在飞书开放平台创建企业自建应用 → 拿到 APP_ID + APP_SECRET
#   2. 已创建多维表格（一个 base 即可） → 拿到 APP_TOKEN + TABLE_ID
#   3. .env 填好上述 4 个变量 + LLM 配置
#
# 脚本会：
#   1. 验证飞书凭证可用（get tenant token）
#   2. 自动添加必需字段（职位/公司/状态/薪资/城市）—— 已存在则跳过
#   3. 添加 N 行『待投递』测试数据
#
# 后续：跑 `bash scripts/test-auto-greet.sh N` 实测 auto-greet
# ============================================================

set -euo pipefail

# ============== 配色 ==============
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

TEST_ROWS="${1:-3}"
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FEISHU_BASE="https://open.feishu.cn/open-apis"

ok()   { echo -e "${GREEN}✓${NC} $1"; }
fail() { echo -e "${RED}✗${NC} $1"; }
warn() { echo -e "${YELLOW}⚠${NC} $1"; }
info() { echo -e "${BLUE}ℹ${NC} $1"; }
step() { echo -e "\n${BLUE}━━━ $1 ━━━${NC}"; }

cd "$PROJECT_ROOT"

# ============================================================
# Step 1: 读 .env
# ============================================================
step "Step 1/4 读取 .env"

if [[ ! -f .env ]]; then
  fail ".env 不存在，请先 cp .env.example .env 并填值"
  exit 1
fi

# 提取 .env 变量（手工解析，不用 source 避免空格问题）
get_env_var() {
  local key="$1"
  # 跳过注释行（# 开头），匹配 KEY=VALUE（VALUE 可能在引号中或含空格）
  grep -v '^[[:space:]]*#' .env \
    | grep -E "^${key}=" \
    | head -1 \
    | sed -E "s/^${key}=//; s/^['\"]//; s/['\"]$//"
}

FEISHU_APP_ID=$(get_env_var FEISHU_APP_ID)
FEISHU_APP_SECRET=$(get_env_var FEISHU_APP_SECRET)
FEISHU_APP_TOKEN=$(get_env_var FEISHU_APP_TOKEN)
FEISHU_TABLE_ID=$(get_env_var FEISHU_TABLE_ID)

# 校验必填
missing=()
for var in FEISHU_APP_ID FEISHU_APP_SECRET FEISHU_APP_TOKEN FEISHU_TABLE_ID; do
  if [[ -z "${!var:-}" ]] || [[ "${!var}" == "你的"* ]]; then
    missing+=("$var")
  fi
done

if [[ ${#missing[@]} -gt 0 ]]; then
  fail ".env 缺失或为占位符: ${missing[*]}"
  echo ""
  echo "获取方式："
  echo "  1. 飞书开放平台创建应用: https://open.feishu.cn/app"
  echo "     → 拿到 FEISHU_APP_ID 和 FEISHU_APP_SECRET"
  echo "  2. 创建多维表格（base），打开后 URL:"
  echo "     https://xxx.feishu.cn/base/<APP_TOKEN>?table=<TABLE_ID>"
  echo "     → APP_TOKEN = /base/ 后那串"
  echo "     → TABLE_ID = ?table= 后那串"
  exit 1
fi

ok "凭证完整（APP_ID=${FEISHU_APP_ID:0:8}..., APP_TOKEN=${FEISHU_APP_TOKEN:0:8}...）"
info "表格 ID: $FEISHU_TABLE_ID"

# ============================================================
# Step 2: 获取 tenant_access_token
# ============================================================
step "Step 2/4 验证飞书凭证"

token_resp=$(curl -sS -X POST "$FEISHU_BASE/auth/v3/tenant_access_token/internal" \
  -H "Content-Type: application/json" \
  -d "{\"app_id\":\"$FEISHU_APP_ID\",\"app_secret\":\"$FEISHU_APP_SECRET\"}")

TENANT_TOKEN=$(echo "$token_resp" | python3 -c "
import sys, json
data = json.load(sys.stdin)
if data.get('code') != 0:
    print('ERROR:' + data.get('msg', 'unknown'), file=sys.stderr)
    sys.exit(1)
print(data['tenant_access_token'])
")

if [[ -z "$TENANT_TOKEN" ]]; then
  fail "获取 tenant_access_token 失败"
  echo "$token_resp"
  exit 1
fi
ok "tenant_access_token 获取成功"

# ============================================================
# Step 3: 检查并创建字段
# ============================================================
step "Step 3/4 检查并创建字段"

# 读现有字段
fields_resp=$(curl -sS "$FEISHU_BASE/bitable/v1/apps/$FEISHU_APP_TOKEN/tables/$FEISHU_TABLE_ID/fields" \
  -H "Authorization: Bearer $TENANT_TOKEN")

existing_fields=$(echo "$fields_resp" | python3 -c "
import sys, json
data = json.load(sys.stdin)
if data.get('code') != 0:
    print('ERROR:' + data.get('msg', 'unknown'), file=sys.stderr)
    sys.exit(1)
print(' '.join(item['field_name'] for item in data.get('data', {}).get('items', [])))
")

info "现有字段: ${existing_fields:-（空表）}"

# 必需字段定义（type 1=文本, 3=单选）
# 注意：macOS 默认 bash 3.2 不支持关联数组，用并行索引数组替代
FIELD_NAMES=("职位" "公司" "BOSS_ID" "状态" "薪资" "城市")
FIELD_TYPES=("1"     "1"     "1"        "3"     "1"     "1")   # 1=文本, 3=单选
# 字段说明：
#   - 职位：公司招聘的岗位名称（如"前端工程师"）
#   - 公司：公司名称
#   - BOSS_ID：⭐ BOSS 直聘的 encryptJobId（auto-greet 必需！）
#             没有这个字段 sync --auto-greet 会显式报错，不会偷偷拿无效 URL 去请求
#   - 状态：单选项（待投递/已投递/已沟通/不合适）
#   - 薪资：薪资范围
#   - 城市：工作城市

# 状态字段选项
STATUS_OPTIONS='{"options":[{"name":"待投递","color":0},{"name":"已投递","color":1},{"name":"已沟通","color":2},{"name":"不合适","color":3}]}'

for i in "${!FIELD_NAMES[@]}"; do
  field_name="${FIELD_NAMES[$i]}"
  field_type="${FIELD_TYPES[$i]}"

  if echo " $existing_fields " | grep -q " $field_name "; then
    ok "字段已存在: $field_name"
    continue
  fi

  info "创建字段: $field_name (type=$field_type)"

  body="{\"field_name\":\"$field_name\",\"type\":$field_type"
  if [[ "$field_name" == "状态" ]]; then
    body+=",\"property\":$STATUS_OPTIONS"
  fi
  body+="}"

  create_resp=$(curl -sS -X POST "$FEISHU_BASE/bitable/v1/apps/$FEISHU_APP_TOKEN/tables/$FEISHU_TABLE_ID/fields" \
    -H "Authorization: Bearer $TENANT_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$body")

  create_code=$(echo "$create_resp" | python3 -c "import sys, json; print(json.load(sys.stdin).get('code'))")
  if [[ "$create_code" != "0" ]]; then
    fail "创建字段 $field_name 失败: $(echo "$create_resp" | python3 -c "import sys, json; print(json.load(sys.stdin).get('msg'))")"
    exit 1
  fi
  ok "字段创建成功: $field_name"
done

# ============================================================
# Step 4: 添加测试数据
# ============================================================
step "Step 4/4 添加 $TEST_ROWS 行『待投递』测试数据"

# 测试岗位样本
declare -a SAMPLE_JOBS=(
  '{"职位":"前端工程师","公司":"字节跳动","状态":"待投递","薪资":"25-50K","城市":"北京"}'
  '{"职位":"Node.js 后端","公司":"美团","状态":"待投递","薪资":"20-40K","城市":"北京"}'
  '{"职位":"全栈工程师","公司":"腾讯","状态":"待投递","薪资":"30-55K","城市":"深圳"}'
  '{"职位":"DevOps 工程师","公司":"阿里云","状态":"待投递","薪资":"25-50K","城市":"杭州"}'
  '{"职位":"数据工程师","公司":"小红书","状态":"待投递","薪资":"20-45K","城市":"上海"}'
)

added=0
for ((i=0; i<TEST_ROWS; i++)); do
  job="${SAMPLE_JOBS[$i]:-${SAMPLE_JOBS[0]}}"  # 超出样本时复用第一条
  info "添加 [$((i+1))/$TEST_ROWS]: $job"

  create_resp=$(curl -sS -X POST "$FEISHU_BASE/bitable/v1/apps/$FEISHU_APP_TOKEN/tables/$FEISHU_TABLE_ID/records" \
    -H "Authorization: Bearer $TENANT_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"fields\":$job}")

  create_code=$(echo "$create_resp" | python3 -c "import sys, json; print(json.load(sys.stdin).get('code'))")
  if [[ "$create_code" != "0" ]]; then
    fail "添加失败: $(echo "$create_resp" | python3 -c "import sys, json; print(json.load(sys.stdin).get('msg'))")"
    continue
  fi
  added=$((added + 1))
  record_id=$(echo "$create_resp" | python3 -c "import sys, json; print(json.load(sys.stdin)['data']['record']['record_id'])")
  ok "添加成功: $record_id"
done

echo ""
ok "全部完成！"
echo ""
echo "  添加字段: ${#FIELD_NAMES[@]} 个（职位/公司/状态/薪资/城市）"
echo "  添加数据: $added / $TEST_ROWS 行"
echo ""
info "下一步："
echo "  1. 在飞书表格里核对字段和数据"
echo "  2. 跑实测："
echo "     bash scripts/test-auto-greet.sh $TEST_ROWS"