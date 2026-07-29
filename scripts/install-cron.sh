#!/usr/bin/env bash
# ============================================================
# scripts/install-cron.sh — Sprint E-2 (2026-07-29)
#
# 目的: 一键装 macOS launchd / Linux crontab 调度 bapply auto.
#       per ADR-0016 §17.16, 时间 09:00 / 14:00 周一至五 (修订自 §2 草案 09:30).
#
# 用法:
#   bash scripts/install-cron.sh [flags]
#
# Flags:
#   --uninstall            卸载 (load/rm plist 或 crontab remove matched lines)
#   --dry-run              只打印 plist/crontab 内容, 不写盘 + 不调 launchctl/crontab
#   --phase morning|afternoon|both  default: both
#   --hour-morning <0-23>  default: 9
#   --minute-morning <0-59> default: 0
#   --hour-afternoon <0-23>  default: 14
#   --minute-afternoon <0-59> default: 0
#
# 退出码 (per §3.13 错误分层):
#   0 = success / dry-run ok
#   1 = INSTALL.config (auto.yaml 缺失)
#   2 = INSTALL.binary (bapply 找不到)
#   3 = INSTALL.os (不支持的平台)
#   4 = INSTALL.launchd (macOS launchctl 失败)
#   5 = INSTALL.crontab (Linux crontab 失败)
#
# 后续: bash scripts/install-cron.sh --uninstall 卸载
# ============================================================

set -euo pipefail

# ============== 配色 (对齐 scripts/init-feishu.sh) ==============
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

ok()   { echo -e "${GREEN}✓${NC} $1"; }
fail() { echo -e "${RED}✗${NC} $1" >&2; }
warn() { echo -e "${YELLOW}⚠${NC} $1"; }
info() { echo -e "${BLUE}ℹ${NC} $1"; }
step() { echo -e "\n${BLUE}━━━ $1 ━━━${NC}"; }

# ============== 默认值 ==============
PHASE='both'
HOUR_MORNING=9
MINUTE_MORNING=0
HOUR_AFTERNOON=14
MINUTE_AFTERNOON=0
DO_UNINSTALL=0
DO_DRY_RUN=0

# ============== Flag 解析 ==============
while [[ $# -gt 0 ]]; do
  case "$1" in
    --uninstall) DO_UNINSTALL=1; shift ;;
    --dry-run) DO_DRY_RUN=1; shift ;;
    --phase)
      PHASE="$2"
      if [[ "$PHASE" != "morning" && "$PHASE" != "afternoon" && "$PHASE" != "both" ]]; then
        fail "--phase 必须是 morning|afternoon|both, 收到: $PHASE"
        exit 2
      fi
      shift 2 ;;
    --hour-morning) HOUR_MORNING="$2"; shift 2 ;;
    --minute-morning) MINUTE_MORNING="$2"; shift 2 ;;
    --hour-afternoon) HOUR_AFTERNOON="$2"; shift 2 ;;
    --minute-afternoon) MINUTE_AFTERNOON="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,32p' "$0"
      exit 0 ;;
    *)
      fail "未知 flag: $1"
      exit 2 ;;
  esac
done

# ============== 探测 OS ==============
OS="$(uname -s)"
case "$OS" in
  Darwin) PLATFORM='darwin' ;;
  Linux)  PLATFORM='linux' ;;
  *)
    fail "[INSTALL.os] 不支持的平台: $OS (仅支持 macOS / Linux)"
    exit 3 ;;
esac
info "平台: $OS"

# ============== 路径探测 ==============
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HOME_DIR="${HOME:-$(eval echo ~)}"
BAPPLY_DIR="$HOME_DIR/.bapply"
LOGS_DIR="$BAPPLY_DIR/logs"

# ============== 检查 auto.yaml (per §17.16) ==============
AUTO_YAML="$BAPPLY_DIR/auto.yaml"
if [[ ! -f "$AUTO_YAML" ]]; then
  fail "[INSTALL.config] $AUTO_YAML 不存在"
  echo "请先跑: bapply auto init-config" >&2
  exit 1
fi
ok "auto.yaml 已存在: $AUTO_YAML"

# ============== 探测 bapply ==============
BAPPLY_PATH="$(command -v bapply 2>/dev/null || true)"
if [[ -z "$BAPPLY_PATH" ]]; then
  # fallback: bin/bapply.js
  BAPPLY_PATH="$PROJECT_ROOT/bin/bapply.js"
  if [[ ! -f "$BAPPLY_PATH" ]]; then
    fail "[INSTALL.binary] 找不到 bapply (PATH 空, 且 $BAPPLY_PATH 不存在)"
    echo "请先: npm link 或 npm i -g ." >&2
    exit 2
  fi
fi
ok "bapply: $BAPPLY_PATH"

# ============== 探测 FEISHU_WEBHOOK_URL (缺省 warn 不阻断) ==============
FEISHU_URL="${FEISHU_WEBHOOK_URL:-}"
if [[ -z "$FEISHU_URL" ]]; then
  warn "[INSTALL.env] FEISHU_WEBHOOK_URL 未设置 — 风控事件仅 console 通知, 不会推飞书"
  echo "  后续可设: export FEISHU_WEBHOOK_URL=https://open.feishu.cn/... 然后重跑本脚本" >&2
else
  ok "[INSTALL.env] FEISHU_WEBHOOK_URL 已设置"
fi

# ============== macOS launchd plist 生成 ==============
PLIST_LABEL='com.boss-apply.auto'
PLIST_PATH="$HOME_DIR/Library/LaunchAgents/$PLIST_LABEL.plist"
LOGS_OUT="$LOGS_DIR/auto.out.log"
LOGS_ERR="$LOGS_DIR/auto.err.log"

# 构建 ProgramArguments (per phase)
build_program_args_macos() {
  echo "<string>$BAPPLY_PATH</string>"
  echo "<string>auto</string>"
  if [[ "$PHASE" == "morning" || "$PHASE" == "both" ]]; then
    echo "<string>--phase</string><string>morning</string>"
  fi
  if [[ "$PHASE" == "afternoon" || "$PHASE" == "both" ]]; then
    echo "<string>--phase</string><string>afternoon</string>"
  fi
}

# Weekday 1-5 (Mon-Fri)
build_calendar_intervals_macos() {
  local count=0
  if [[ "$PHASE" == "morning" || "$PHASE" == "both" ]]; then
    cat <<EOF
      <dict>
        <key>Hour</key><integer>$HOUR_MORNING</integer>
        <key>Minute</key><integer>$MINUTE_MORNING</integer>
        <key>Weekday</key><integer>1</integer>
      </dict>
      <dict>
        <key>Hour</key><integer>$HOUR_MORNING</integer>
        <key>Minute</key><integer>$MINUTE_MORNING</integer>
        <key>Weekday</key><integer>2</integer>
      </dict>
      <dict>
        <key>Hour</key><integer>$HOUR_MORNING</integer>
        <key>Minute</key><integer>$MINUTE_MORNING</integer>
        <key>Weekday</key><integer>3</integer>
      </dict>
      <dict>
        <key>Hour</key><integer>$HOUR_MORNING</integer>
        <key>Minute</key><integer>$MINUTE_MORNING</integer>
        <key>Weekday</key><integer>4</integer>
      </dict>
      <dict>
        <key>Hour</key><integer>$HOUR_MORNING</integer>
        <key>Minute</key><integer>$MINUTE_MORNING</integer>
        <key>Weekday</key><integer>5</integer>
      </dict>
EOF
    count=$((count + 5))
  fi
  if [[ "$PHASE" == "afternoon" || "$PHASE" == "both" ]]; then
    cat <<EOF
      <dict>
        <key>Hour</key><integer>$HOUR_AFTERNOON</integer>
        <key>Minute</key><integer>$MINUTE_AFTERNOON</integer>
        <key>Weekday</key><integer>1</integer>
      </dict>
      <dict>
        <key>Hour</key><integer>$HOUR_AFTERNOON</integer>
        <key>Minute</key><integer>$MINUTE_AFTERNOON</integer>
        <key>Weekday</key><integer>2</integer>
      </dict>
      <dict>
        <key>Hour</key><integer>$HOUR_AFTERNOON</integer>
        <key>Minute</key><integer>$MINUTE_AFTERNOON</integer>
        <key>Weekday</key><integer>3</integer>
      </dict>
      <dict>
        <key>Hour</key><integer>$HOUR_AFTERNOON</integer>
        <key>Minute</key><integer>$MINUTE_AFTERNOON</integer>
        <key>Weekday</key><integer>4</integer>
      </dict>
      <dict>
        <key>Hour</key><integer>$HOUR_AFTERNOON</integer>
        <key>Minute</key><integer>$MINUTE_AFTERNOON</integer>
        <key>Weekday</key><integer>5</integer>
      </dict>
EOF
    count=$((count + 5))
  fi
  echo "[INFO] generated $count StartCalendarInterval entries" >&2
}

build_plist_macos() {
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$PLIST_LABEL</string>
  <key>ProgramArguments</key>
  <array>
$(build_program_args_macos | sed 's/^/    /')
  </array>
  <key>StartCalendarInterval</key>
  <array>
$(build_calendar_intervals_macos | sed 's/^/    /')
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>FEISHU_WEBHOOK_URL</key>
    <string>${FEISHU_URL:-}</string>
  </dict>
  <key>StandardOutPath</key>
  <string>$LOGS_OUT</string>
  <key>StandardErrorPath</key>
  <string>$LOGS_ERR</string>
  <key>RunAtLoad</key>
  <false/>
  <key>KeepAlive</key>
  <false/>
</dict>
</plist>
EOF
}

# ============== Linux crontab 生成 ==============
build_crontab_linux() {
  if [[ "$PHASE" == "morning" || "$PHASE" == "both" ]]; then
    echo "$MINUTE_MORNING $HOUR_MORNING * * 1-5 $BAPPLY_PATH auto --phase morning"
  fi
  if [[ "$PHASE" == "afternoon" || "$PHASE" == "both" ]]; then
    echo "$MINUTE_AFTERNOON $HOUR_AFTERNOON * * 1-5 $BAPPLY_PATH auto --phase afternoon"
  fi
}

# ============== 主流程 ==============
step "install-cron: phase=$PHASE morning=$HOUR_MORNING:$MINUTE_MORNING afternoon=$HOUR_AFTERNOON:$MINUTE_AFTERNOON uninstall=$DO_UNINSTALL dryRun=$DO_DRY_RUN"

if [[ "$DO_UNINSTALL" -eq 1 ]]; then
  # ============== Uninstall ==============
  if [[ "$PLATFORM" == "darwin" ]]; then
    info "卸载 launchd plist: $PLIST_PATH"
    if [[ "$DO_DRY_RUN" -eq 1 ]]; then
      info "[dry-run] launchctl unload -w $PLIST_PATH"
      info "[dry-run] rm -f $PLIST_PATH"
      ok "已模拟卸载 (dry-run)"
    else
      if [[ -f "$PLIST_PATH" ]]; then
        launchctl unload "$PLIST_PATH" 2>/dev/null || warn "launchctl unload 失败 (可能未加载)"
        rm -f "$PLIST_PATH"
        ok "plist 已卸载: $PLIST_PATH"
      else
        info "plist 不存在, 跳过: $PLIST_PATH"
      fi
    fi
  else
    info "卸载 crontab (匹配 bapply auto 行)"
    if [[ "$DO_DRY_RUN" -eq 1 ]]; then
      info "[dry-run] crontab -l | grep -v 'bapply auto' | crontab -"
      ok "已模拟卸载 (dry-run)"
    else
      ( crontab -l 2>/dev/null | grep -v "bapply auto" || true ) | crontab -
      ok "crontab 已清理 bapply auto 行"
    fi
  fi
  exit 0
fi

# ============== Install ==============
if [[ "$PLATFORM" == "darwin" ]]; then
  info "macOS launchd plist → $PLIST_PATH"
  PLIST_CONTENT="$(build_plist_macos)"

  if [[ "$DO_DRY_RUN" -eq 1 ]]; then
    echo "$PLIST_CONTENT"
    ok "[dry-run] plist 内容已打印, 未写盘"
  else
    mkdir -p "$(dirname "$PLIST_PATH")"
    mkdir -p "$LOGS_DIR"
    if [[ -f "$PLIST_PATH" ]]; then
      warn "plist 已存在, 覆盖"
    fi
    echo "$PLIST_CONTENT" > "$PLIST_PATH"
    ok "plist 已写: $PLIST_PATH"

    # launchctl load (per §17.16 错误传播)
    if launchctl load -w "$PLIST_PATH" 2>/dev/null; then
      ok "launchctl load -w 成功"
    else
      fail "[INSTALL.launchd] launchctl load -w 失败"
      echo "  手动验证: launchctl list | grep $PLIST_LABEL" >&2
      exit 4
    fi

    # verify
    if launchctl list | grep -q "$PLIST_LABEL"; then
      ok "launchctl list 验证: $PLIST_LABEL 已注册"
    else
      warn "launchctl list 未找到 $PLIST_LABEL (可能因 SIP)"
    fi
  fi

  # 打印 summary
  echo ""
  ok "Cron 已装"
  info "⏰ 下一触发: 周一 ${HOUR_MORNING}:${MINUTE_MORNING} (morning) / 周一 ${HOUR_AFTERNOON}:${MINUTE_AFTERNOON} (afternoon)"
  info "📄 日志: $LOGS_OUT / $LOGS_ERR"
  if [[ -n "$FEISHU_URL" ]]; then
    info "🔔 飞书告警: 已启用"
  else
    warn "⚠️  飞书告警: 未启用 (FEISHU_WEBHOOK_URL 未设)"
  fi
  info "🗑️  卸载: bash scripts/install-cron.sh --uninstall"
else
  # Linux crontab
  info "Linux crontab"
  CRONTAB_CONTENT="$(build_crontab_linux)"

  if [[ "$DO_DRY_RUN" -eq 1 ]]; then
    echo "$CRONTAB_CONTENT"
    ok "[dry-run] crontab 内容已打印, 未写盘"
  else
    # idempotent: 先清掉旧 bapply auto 行, 再追加新行
    ( crontab -l 2>/dev/null | grep -v "bapply auto" || true
      echo "$CRONTAB_CONTENT"
    ) | crontab - 2>/dev/null || {
      fail "[INSTALL.crontab] crontab 写入失败"
      exit 5
    }
    ok "crontab 已更新"

    # verify
    if crontab -l 2>/dev/null | grep -q "bapply auto"; then
      ok "crontab -l 验证: bapply auto 行已注册"
    else
      warn "crontab -l 未找到 bapply auto 行"
    fi
  fi

  echo ""
  ok "Cron 已装"
  info "⏰ 下一触发: 周一 ${HOUR_MORNING}:${MINUTE_MORNING} (morning) / 周一 ${HOUR_AFTERNOON}:${MINUTE_AFTERNOON} (afternoon)"
  info "📄 日志: 走 mail 或 /var/log/syslog (Linux 默认无独立 stdout file)"
  if [[ -n "$FEISHU_URL" ]]; then
    info "🔔 飞书告警: 已启用"
  else
    warn "⚠️  飞书告警: 未启用 (FEISHU_WEBHOOK_URL 未设)"
  fi
  info "🗑️  卸载: bash scripts/install-cron.sh --uninstall"
fi