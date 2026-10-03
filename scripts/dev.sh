#!/usr/bin/env bash
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

SERVICE_ROOT="${MASHANG_SERVICE_ROOT:-$HOME/Documents/github/mashang-service}"
HUB_HOST="${HUB_HOST:-127.0.0.1}"
HUB_PORT="${PORT:-3000}"
OPENCODE_HOST="${OPENCODE_HOST:-127.0.0.1}"
OPENCODE_PORT="${OPENCODE_PORT:-4096}"
WORKER_SECRET="${WORKER_SECRET:-local-worker-secret}"
HUB_ACCESS_TOKEN="${HUB_ACCESS_TOKEN:-}"

LOCAL_DIR="$ROOT/.local"
LOG_DIR="$LOCAL_DIR/logs"
PID_DIR="$LOCAL_DIR/pids"
mkdir -p "$LOG_DIR" "$PID_DIR"

green() { printf '\033[32m%s\033[0m\n' "$1"; }
yellow() { printf '\033[33m%s\033[0m\n' "$1"; }
red() { printf '\033[31m%s\033[0m\n' "$1"; }

pid_of() { cat "$PID_DIR/$1.pid" 2>/dev/null || true; }

is_running() {
  local pid
  pid="$(pid_of "$1")"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

port_listening() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
}

wait_port() {
  local port="$1" tries="${2:-50}" i
  for ((i = 0; i < tries; i++)); do
    port_listening "$port" && return 0
    sleep 0.2
  done
  return 1
}

start_proc() {
  local name="$1" dir="$2"
  shift 2
  if is_running "$name"; then
    yellow "• $name 已在运行 (pid $(pid_of "$name"))"
    return 0
  fi
  if [[ ! -d "$dir" ]]; then
    red "✗ $name 启动失败：目录不存在 $dir"
    return 1
  fi
  ( cd "$dir" && exec "$@" ) >"$LOG_DIR/$name.log" 2>&1 &
  local pid=$!
  echo "$pid" >"$PID_DIR/$name.pid"
  green "▶ $name 启动 (pid $pid) → $LOG_DIR/$name.log"
}

stop_proc() {
  local name="$1" pid i
  pid="$(pid_of "$name")"
  if [[ -z "$pid" ]]; then
    yellow "• $name 未运行"
    return 0
  fi
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null
    for ((i = 0; i < 25; i++)); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.2
    done
    if kill -0 "$pid" 2>/dev/null; then
      kill -9 "$pid" 2>/dev/null
    fi
    green "■ $name 已停止 (pid $pid)"
  else
    yellow "• $name 进程已不存在，清理 pid"
  fi
  rm -f "$PID_DIR/$name.pid"
}

cmd_start() {
  echo "== mashang-hub start =="

  if is_running opencode; then
    yellow "• opencode 已在运行 (pid $(pid_of opencode))"
  elif port_listening "$OPENCODE_PORT"; then
    yellow "• 端口 $OPENCODE_PORT 已有服务，跳过 opencode 启动"
  else
    start_proc opencode "$SERVICE_ROOT" \
      opencode serve --hostname "$OPENCODE_HOST" --port "$OPENCODE_PORT"
    if wait_port "$OPENCODE_PORT"; then
      green "  opencode ready → http://$OPENCODE_HOST:$OPENCODE_PORT"
    else
      yellow "  opencode 端口 $OPENCODE_PORT 未就绪，请查看日志"
    fi
  fi

  if ! is_running hub && port_listening "$HUB_PORT"; then
    red "✗ 端口 $HUB_PORT 已被其他进程占用，跳过 hub（可改用 PORT=3001 $0 start）"
  else
    start_proc hub "$ROOT" \
      env HUB_HOST="$HUB_HOST" PORT="$HUB_PORT" \
      WORKER_SECRET="$WORKER_SECRET" HUB_ACCESS_TOKEN="$HUB_ACCESS_TOKEN" \
      node server.mjs
    if wait_port "$HUB_PORT"; then
      green "  hub ready → http://$HUB_HOST:$HUB_PORT"
    else
      yellow "  hub 端口 $HUB_PORT 未就绪，请查看日志"
    fi
  fi

  start_proc worker "$ROOT" \
    env HUB_URL="ws://$HUB_HOST:$HUB_PORT" WORKER_SECRET="$WORKER_SECRET" \
    MASHANG_SERVICE_ROOT="$SERVICE_ROOT" \
    OPENCODE_URL="http://$OPENCODE_HOST:$OPENCODE_PORT" \
    node worker/worker.mjs

  echo
  green "完成。状态：$0 status  日志：$0 logs"
}

cmd_stop() {
  echo "== mashang-hub stop =="
  stop_proc worker
  stop_proc hub
  stop_proc opencode
  local p
  for p in "$HUB_PORT" "$OPENCODE_PORT"; do
    if port_listening "$p"; then
      yellow "• 端口 $p 仍被占用（可能是外部启动的进程）"
    fi
  done
  green "完成。"
}

cmd_status() {
  local name
  for name in opencode hub worker; do
    if is_running "$name"; then
      green "● $name running (pid $(pid_of "$name"))"
    else
      red "○ $name stopped"
    fi
  done
  echo
  echo "hub:      http://$HUB_HOST:$HUB_PORT"
  echo "logs:     $LOG_DIR"
  echo "pidfiles: $PID_DIR"
}

cmd_logs() {
  local files=()
  local name
  for name in opencode hub worker; do
    [[ -f "$LOG_DIR/$name.log" ]] && files+=("$LOG_DIR/$name.log")
  done
  if [[ ${#files[@]} -eq 0 ]]; then
    yellow "暂无日志，先启动：$0 start"
    return 0
  fi
  tail -n 40 -f "${files[@]}"
}

usage() {
  cat <<EOF
用法: $0 {start|stop|restart|status|logs}

环境变量（可选）:
  MASHANG_SERVICE_ROOT  默认 ~/Documents/github/mashang-service
  PORT / HUB_HOST       Hub 端口与地址，默认 3000 / 127.0.0.1
  OPENCODE_PORT         默认 4096
  WORKER_SECRET         默认 local-worker-secret
  HUB_ACCESS_TOKEN      设置后启用登录门禁
EOF
}

case "${1:-}" in
  start) cmd_start ;;
  stop) cmd_stop ;;
  restart)
    cmd_stop
    echo
    cmd_start
    ;;
  status) cmd_status ;;
  logs) cmd_logs ;;
  *) usage ;;
esac
