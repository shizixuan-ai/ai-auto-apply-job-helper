#!/usr/bin/env bash
# ============================================================
# start-chrome.sh trap 自验测试（不依赖 bats-core，零外部依赖）
# ============================================================
# 复审子 Agent 在 commit bfae2bc 复审里指出的 "无自动化测试覆盖 trap 4 条路径"。
#
# 测 4 个退出路径，每条路径独立子 shell，互不污染：
#   1. EXIT 0（成功启动 + 正常退出）→ Chrome + profile 应保留
#   2. EXIT 1（端口被占，早失败）→ PROFILE_DIR 不应被建
#   3. INT（Ctrl-C）→ PROFILE_DIR + PID_FILE 应清理
#   4. TERM（kill -TERM）→ PROFILE_DIR + PID_FILE 应清理
#
# 用法：bash scripts/test-start-chrome-trap.sh
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TARGET_SCRIPT="${PROJECT_ROOT}/scripts/start-chrome.sh"

passed=0
failed=0
ok()    { echo -e "\033[0;32m✓\033[0m $1"; passed=$((passed + 1)); }
fail()  { echo -e "\033[0;31m✗\033[0m $1"; failed=$((failed + 1)); }
info()  { echo -e "\033[0;34mℹ\033[0m $1"; }

echo "╭─ start-chrome.sh trap 自验（4 条路径）"
echo "│  target: ${TARGET_SCRIPT}"
echo "│"

# ============================================================
# helper：起 fake port holder（写到临时脚本，避开函数 heredoc 缩进问题）
# ============================================================
FAKE_HOLDER_SCRIPT="$(mktemp -t fake_holder).py"
cat > "$FAKE_HOLDER_SCRIPT" <<'PYEOF'
import os, sys, socket, time
port = int(sys.argv[1])
pid = os.fork()
if pid > 0:
    with open('/tmp/fake_holder.pid', 'w') as f:
        f.write(str(pid))
    sys.exit(0)
s = socket.socket()
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(('127.0.0.1', port))
s.listen()
time.sleep(60)
PYEOF

fake_port_hold() {
  local port="$1"
  rm -f /tmp/fake_holder.pid
  python3 "$FAKE_HOLDER_SCRIPT" "$port" &
  disown 2>/dev/null || true
  for _ in $(seq 1 60); do
    [[ -s /tmp/fake_holder.pid ]] && break
    sleep 0.1
  done
  if [[ -s /tmp/fake_holder.pid ]]; then
    cat /tmp/fake_holder.pid
    return 0
  fi
  return 1
}

free_port_hold() {
  if [[ -s /tmp/fake_holder.pid ]]; then
    local p
    p=$(cat /tmp/fake_holder.pid)
    kill -9 "$p" 2>/dev/null || true
    rm -f /tmp/fake_holder.pid
  fi
}

cleanup_root() {
  free_port_hold
  rm -f "$FAKE_HOLDER_SCRIPT" /tmp/chrome-start.profile /tmp/chrome-start.pid
  lsof -ti:9222 2>/dev/null | xargs -r kill -9 2>/dev/null || true
}
trap cleanup_root EXIT

# 干净启动
cleanup_root

# ============================================================
# Test 1: EXIT 0 应保留 Chrome（设计意图：让用户登录）
# ============================================================
echo "├─ Test 1: EXIT 0 路径 → 应保留"
sleep 1

bash "$TARGET_SCRIPT" > /tmp/sc_test1.out 2>&1 &
T1_PID=$!
sleep 8

if lsof -ti:9222 >/dev/null 2>&1; then
  P1=$(lsof -ti:9222 | head -1)
  if [[ -n "$P1" ]] && kill -0 "$P1" 2>/dev/null; then
    ok "Chrome 进程保留 (pid=${P1})"
  else
    fail "Chrome exit 0 后不应该被 kill"
  fi
else
  fail "Chrome 应该保留（EXIT 0 路径），但 9222 没监听"
fi

if [[ -s /tmp/chrome-start.profile ]] && [[ -d "$(cat /tmp/chrome-start.profile)" ]]; then
  ok "PROFILE_DIR 保留: $(cat /tmp/chrome-start.profile)"
else
  fail "PROFILE_DIR 应该保留（EXIT 0 路径）"
fi

# 收拾
lsof -ti:9222 | xargs -r kill -9 2>/dev/null || true
sleep 1
rm -f /tmp/chrome-start.profile /tmp/chrome-start.pid

# ============================================================
# Test 2: EXIT 1 路径（端口被占）应真 exit 1
# ============================================================
echo "├─ Test 2: EXIT 1 路径（端口被占）"
HOLDER=$(fake_port_hold 9222)
sleep 1.5

if [[ -z "$HOLDER" ]] || ! kill -0 "$HOLDER" 2>/dev/null; then
  fail "fake_port_hold 没能占住 9222 (HOLDER='$HOLDER')"
else
  set +e
  bash "$TARGET_SCRIPT" > /tmp/sc_test2.out 2>&1
  T2_EXIT=$?
  set -e 2>/dev/null
  T2_EXIT="${T2_EXIT:-0}"

  if [[ "$T2_EXIT" -eq 1 ]]; then
    ok "脚本真退出码 = 1"
  else
    fail "脚本退出码 = ${T2_EXIT}（期望 1）"
  fi

  if grep -q "端口 9222 已被占用" /tmp/sc_test2.out; then
    ok "报错信息含 '端口 9222 已被占用'"
  else
    fail "缺少端口占用报错"
  fi
fi

if [[ ! -f /tmp/chrome-start.profile ]]; then
  ok "端口失败时 PROFILE_DIR 未被创建（正确）"
else
  fail "端口失败时 PROFILE_DIR 不应该被创建"
fi

free_port_hold
sleep 1

# ============================================================
# Test 3: INT 路径（kill -INT 模拟 Ctrl-C）
# ============================================================
echo "├─ Test 3: INT 路径（kill -INT = Ctrl-C）"
sleep 1

# 用 set -m (job control) + 进程组，让 kill 能触达 bash 的 trap
# 给脚本建独立进程组，kill -INT -$T3_PID 发到整个组
set -m
bash "$TARGET_SCRIPT" > /tmp/sc_test3.out 2>&1 &
T3_PID=$!
sleep 8
set +m

if ! lsof -ti:9222 >/dev/null 2>&1; then
  fail "Chrome 没起来，无法测 INT"
else
  PROFILE_3=""
  [[ -s /tmp/chrome-start.profile ]] && PROFILE_3=$(cat /tmp/chrome-start.profile)

  # kill 整个进程组
  kill -INT -- -"$T3_PID" 2>/dev/null || kill -INT "$T3_PID" 2>/dev/null
  sleep 4

  if lsof -ti:9222 >/dev/null 2>&1; then
    fail "INT 后 Chrome 仍存活（应清理）"
  else
    ok "INT 后 9222 释放（Chrome 已 kill）"
  fi

  if [[ -n "$PROFILE_3" && ! -d "$PROFILE_3" ]]; then
    ok "INT 后 PROFILE_DIR 清理（${PROFILE_3} 已删）"
  else
    fail "INT 后 PROFILE_DIR 应被清理（${PROFILE_3:-empty} 仍在）"
  fi
fi
rm -f /tmp/chrome-start.profile /tmp/chrome-start.pid

# ============================================================
# Test 4: TERM 路径（kill -TERM）
# ============================================================
echo "├─ Test 4: TERM 路径（kill -TERM）"
sleep 1

set -m
bash "$TARGET_SCRIPT" > /tmp/sc_test4.out 2>&1 &
T4_PID=$!
sleep 8
set +m

if ! lsof -ti:9222 >/dev/null 2>&1; then
  fail "Chrome 没起来，无法测 TERM"
else
  PROFILE_4=""
  [[ -s /tmp/chrome-start.profile ]] && PROFILE_4=$(cat /tmp/chrome-start.profile)

  kill -TERM -- -"$T4_PID" 2>/dev/null || kill -TERM "$T4_PID" 2>/dev/null
  sleep 4

  if lsof -ti:9222 >/dev/null 2>&1; then
    fail "TERM 后 Chrome 仍存活"
  else
    ok "TERM 后 9222 释放"
  fi

  if [[ -n "$PROFILE_4" && ! -d "$PROFILE_4" ]]; then
    ok "TERM 后 PROFILE_DIR 清理（${PROFILE_4} 已删）"
  else
    fail "TERM 后 PROFILE_DIR 应被清理（${PROFILE_4:-empty} 仍在）"
  fi
fi
rm -f /tmp/chrome-start.profile /tmp/chrome-start.pid

# ============================================================
# 总结
# ============================================================
echo "│"
echo "╰─ 总结:  ${passed} passed, ${failed} failed"

if [[ "$failed" -gt 0 ]]; then
  exit 1
fi
exit 0
