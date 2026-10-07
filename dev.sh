#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$ROOT_DIR/.env"
STATE_DIR="${MR_REVIEW_DEV_STATE_DIR:-$ROOT_DIR/.dev}"
API_PID_FILE="$STATE_DIR/api.pid"
WEB_PID_FILE="$STATE_DIR/web.pid"
API_PORT_FILE="$STATE_DIR/api.port"
WEB_PORT_FILE="$STATE_DIR/web.port"
API_LOG_FILE="$STATE_DIR/api.log"
WEB_LOG_FILE="$STATE_DIR/web.log"

API_HOST="${MR_REVIEW_API_HOST:-${HOST:-127.0.0.1}}"
API_PORT="${MR_REVIEW_API_PORT:-${PORT:-8080}}"
API_PORT_EXPLICIT=false
if [[ -n "${MR_REVIEW_API_PORT:-}" || -n "${PORT:-}" ]]; then
  API_PORT_EXPLICIT=true
fi
WEB_HOST="${MR_REVIEW_WEB_HOST:-127.0.0.1}"
WEB_PORT="${MR_REVIEW_WEB_PORT:-5173}"
WEB_PORT_EXPLICIT=false
if [[ -n "${MR_REVIEW_WEB_PORT:-}" ]]; then
  WEB_PORT_EXPLICIT=true
fi
WEB_ORIGIN="${WEB_ORIGIN:-}"
VITE_API_PROXY_TARGET="${VITE_API_PROXY_TARGET:-}"
PORT_SCAN_LIMIT="${MR_REVIEW_PORT_SCAN_LIMIT:-100}"

TSX_BIN="$ROOT_DIR/node_modules/.bin/tsx"
VITE_BIN="$ROOT_DIR/node_modules/.bin/vite"
NODE_ENV_FILE_ARGS=()
if [[ -f "$ENV_FILE" ]]; then
  NODE_ENV_FILE_ARGS=("--env-file=$ENV_FILE")
fi
SCREEN_BIN="$(command -v screen || true)"
SCREEN_PREFIX="${MR_REVIEW_SCREEN_PREFIX:-frontend-pilot}"
API_SESSION="$SCREEN_PREFIX-api"
WEB_SESSION="$SCREEN_PREFIX-web"
NODE_BIN=""

load_node() {
  local nvm_script=""
  if [[ -n "${NVM_DIR:-}" && -s "$NVM_DIR/nvm.sh" ]]; then
    nvm_script="$NVM_DIR/nvm.sh"
  elif [[ "$(uname -s)" == "Darwin" ]]; then
    nvm_script="/Users/$(id -un)/.nvm/nvm.sh"
  fi

  if [[ -s "$nvm_script" ]]; then
    # shellcheck disable=SC1090
    source "$nvm_script"
    nvm use "${MR_REVIEW_NODE_VERSION:-24}" >/dev/null
  fi

  if ! command -v node >/dev/null 2>&1; then
    echo "Node.js is not available." >&2
    return 1
  fi

  local node_major
  node_major="$(node -p 'process.versions.node.split(".")[0]')"
  if (( node_major != 24 )); then
    echo "Node.js 24 is required; found $(node --version)." >&2
    return 1
  fi
  NODE_BIN="$(command -v node)"
}

env_file_value() {
  local key="$1"
  [[ -f "$ENV_FILE" ]] || return 0
  "$NODE_BIN" "${NODE_ENV_FILE_ARGS[@]}" -p "process.env.${key} ?? ''" 2>/dev/null
}

read_pid() {
  local pid_file="$1"
  local pid
  [[ -f "$pid_file" ]] || return 1
  read -r pid < "$pid_file"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  printf '%s\n' "$pid"
}

read_port_file() {
  local port_file="$1"
  local port
  [[ -f "$port_file" ]] || return 1
  IFS= read -r port < "$port_file" || return 1
  valid_port "$port" || return 1
  printf '%s\n' "$((10#$port))"
}

valid_port() {
  local port="$1"
  [[ "$port" =~ ^[0-9]+$ ]] || return 1
  port="$((10#$port))"
  (( port >= 1 && port <= 65535 ))
}

process_command() {
  ps -p "$1" -o command= 2>/dev/null | sed 's/^[[:space:]]*//' || true
}

is_alive() {
  kill -0 "$1" 2>/dev/null
}

screen_session_exists() {
  [[ -n "$SCREEN_BIN" ]] || return 1
  { "$SCREEN_BIN" -ls 2>/dev/null || true; } | awk -v session="$1" \
    'index($1, "." session) == length($1) - length("." session) + 1 { found = 1 } END { exit !found }'
}

screen_pid_for() {
  [[ -n "$SCREEN_BIN" ]] || return 1
  { "$SCREEN_BIN" -ls 2>/dev/null || true; } | awk -v session="$1" \
    'index($1, "." session) == length($1) - length("." session) + 1 { split($1, parts, "."); print parts[1]; exit }'
}

service_alive() {
  local reference="$1"
  case "$reference" in
    screen:*) screen_session_exists "${reference#screen:}" ;;
    pid:*) is_alive "${reference#pid:}" ;;
    *) return 1 ;;
  esac
}

screen_start() {
  local session="$1"
  local log_file="$2"
  local work_dir="$3"
  shift 3
  local command="cd"
  local argument
  local quoted
  printf -v quoted '%q' "$work_dir"
  command+=" $quoted && exec "
  for argument in "$@"; do
    printf -v quoted '%q' "$argument"
    command+="$quoted "
  done
  command+=">>"
  printf -v quoted '%q' "$log_file"
  command+=" $quoted 2>&1"
  "$SCREEN_BIN" -dmS "$session" bash -lc "$command"
}

is_managed_api() {
  local pid="$1"
  local command
  is_alive "$pid" || return 1
  command="$(process_command "$pid")"
  [[ "$command" == *"$ROOT_DIR/src/server.ts"* && "$command" == *"tsx"* ]]
}

is_managed_web() {
  local pid="$1"
  local command
  is_alive "$pid" || return 1
  command="$(process_command "$pid")"
  [[ "$command" == *"$ROOT_DIR"* && "$command" == *"vite"* ]]
}

child_pids() {
  ps -axo pid=,ppid= | awk -v parent="$1" '$2 == parent {print $1}'
}

terminate_process_tree() {
  local pid="$1"
  local child
  while read -r child; do
    [[ -n "$child" ]] || continue
    terminate_process_tree "$child"
  done < <(child_pids "$pid")
  kill -TERM "$pid" 2>/dev/null || true
}

wait_for_exit() {
  local pid="$1"
  local attempt
  for attempt in {1..50}; do
    is_alive "$pid" || return 0
    sleep 0.1
  done
  return 1
}

stop_service() {
  local name="$1"
  local pid_file="$2"
  local checker="$3"
  local session="$4"
  local pid

  if screen_session_exists "$session"; then
    local screen_pid
    screen_pid="$(screen_pid_for "$session" || true)"
    if [[ -n "$screen_pid" ]]; then
      terminate_process_tree "$screen_pid"
    fi
    "$SCREEN_BIN" -S "$session" -X quit >/dev/null 2>&1 || true
    local attempt
    for attempt in {1..50}; do
      screen_session_exists "$session" || break
      sleep 0.1
    done
    rm -f "$pid_file"
    echo "$name stopped (screen session $session)."
    return 0
  fi

  pid="$(read_pid "$pid_file" 2>/dev/null || true)"

  if [[ -z "$pid" ]]; then
    rm -f "$pid_file"
    echo "$name is not running."
    return 0
  fi

  if ! "$checker" "$pid"; then
    rm -f "$pid_file"
    echo "Removed stale $name PID file: $pid_file"
    return 0
  fi

  terminate_process_tree "$pid"
  if ! wait_for_exit "$pid" && "$checker" "$pid"; then
    terminate_process_tree "$pid"
    kill -KILL "$pid" 2>/dev/null || true
  fi

  rm -f "$pid_file"
  echo "$name stopped (pid $pid)."
}

port_owner() {
  command -v lsof >/dev/null 2>&1 || return 0
  lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | head -n 1
}

port_is_available() {
  local port="$1"
  local checker="$2"
  local owner
  owner="$(port_owner "$port")"
  [[ -z "$owner" ]] && return 0
  [[ -n "$checker" ]] && "$checker" "$owner"
}

port_scan_end() {
  local start="$1"
  local end=$((start + PORT_SCAN_LIMIT))
  (( end > 65535 )) && end=65535
  printf '%s\n' "$end"
}

find_managed_port() {
  local start="$1"
  local end="$2"
  local checker="$3"
  local candidate owner
  for ((candidate = start; candidate <= end; candidate += 1)); do
    owner="$(port_owner "$candidate")"
    if [[ -n "$owner" ]] && "$checker" "$owner"; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

find_available_port() {
  local start="$1"
  local end="$2"
  local checker="$3"
  local candidate
  for ((candidate = start; candidate <= end; candidate += 1)); do
    if port_is_available "$candidate" "$checker"; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  echo "No available port found between $start and $end." >&2
  return 1
}

ensure_port_available() {
  local port="$1"
  local checker="${2:-}"
  local port_variable="${3:-MR_REVIEW_API_PORT}"
  local owner
  owner="$(port_owner "$port")"
  [[ -z "$owner" ]] && return 0

  if [[ -n "$checker" ]] && "$checker" "$owner"; then
    return 0
  fi

  echo "Cannot start Frontend Pilot: port $port is already in use by another process (pid $owner)." >&2
  echo "Owner: $(process_command "$owner")" >&2
  echo "Choose another port, for example: $port_variable=<free-port> ./dev.sh start" >&2
  return 1
}

resolve_ports() {
  local saved_port managed_port scan_end

  if [[ "$API_PORT_EXPLICIT" == true ]]; then
    if ! valid_port "$API_PORT"; then
      echo "Invalid API port: $API_PORT" >&2
      return 1
    fi
  else
    scan_end="$(port_scan_end "$API_PORT")"
    saved_port="$(read_port_file "$API_PORT_FILE" 2>/dev/null || true)"
    if [[ -n "$saved_port" ]] && port_is_available "$saved_port" is_managed_api; then
      API_PORT="$saved_port"
    elif managed_port="$(find_managed_port "$API_PORT" "$scan_end" is_managed_api)"; then
      API_PORT="$managed_port"
    else
      API_PORT="$(find_available_port "$API_PORT" "$scan_end" is_managed_api)"
    fi
  fi

  if [[ "$WEB_PORT_EXPLICIT" == true ]]; then
    if ! valid_port "$WEB_PORT"; then
      echo "Invalid web port: $WEB_PORT" >&2
      return 1
    fi
  else
    scan_end="$(port_scan_end "$WEB_PORT")"
    saved_port="$(read_port_file "$WEB_PORT_FILE" 2>/dev/null || true)"
    if [[ -n "$saved_port" ]] && port_is_available "$saved_port" is_managed_web; then
      WEB_PORT="$saved_port"
    elif managed_port="$(find_managed_port "$WEB_PORT" "$scan_end" is_managed_web)"; then
      WEB_PORT="$managed_port"
    else
      WEB_PORT="$(find_available_port "$WEB_PORT" "$scan_end" is_managed_web)"
    fi
  fi

  if [[ "$API_PORT" == "$WEB_PORT" ]]; then
    echo "API and web ports must be different (both are $API_PORT)." >&2
    return 1
  fi
}

write_port_state() {
  printf '%s\n' "$API_PORT" > "$API_PORT_FILE"
  printf '%s\n' "$WEB_PORT" > "$WEB_PORT_FILE"
}

preflight_ports() {
  ensure_port_available "$API_PORT" is_managed_api MR_REVIEW_API_PORT || return 1
  ensure_port_available "$WEB_PORT" is_managed_web MR_REVIEW_WEB_PORT || return 1
}

wait_for_url() {
  local url="$1"
  local reference="$2"
  local label="$3"
  local attempt
  for attempt in {1..60}; do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    if ! service_alive "$reference"; then
      echo "$label exited during startup." >&2
      return 1
    fi
    sleep 0.1
  done
  echo "$label did not become ready at $url." >&2
  return 1
}

show_logs() {
  local file="$1"
  [[ -f "$file" ]] || return 0
  tail -n 30 "$file" >&2 || true
}

start_api() {
  local gitlab_oauth_redirect_uri="$1"
  if screen_session_exists "$API_SESSION"; then
    echo "API is already running (screen session $API_SESSION)." >&2
    printf 'screen:%s\n' "$API_SESSION"
    return 0
  fi

  local existing_pid
  existing_pid="$(read_pid "$API_PID_FILE" 2>/dev/null || true)"
  if [[ -n "$existing_pid" ]] && is_managed_api "$existing_pid"; then
    echo "API is already running (pid $existing_pid)." >&2
    printf 'pid:%s\n' "$existing_pid"
    return 0
  fi
  rm -f "$API_PID_FILE"

  if ! ensure_port_available "$API_PORT" is_managed_api MR_REVIEW_API_PORT; then
    return 1
  fi
  : > "$API_LOG_FILE"
  if [[ -n "$SCREEN_BIN" ]]; then
    screen_start "$API_SESSION" "$API_LOG_FILE" "$ROOT_DIR" \
      env \
      "HOST=$API_HOST" \
      "PORT=$API_PORT" \
      "WEB_ORIGIN=$WEB_ORIGIN" \
      "GITLAB_OAUTH_REDIRECT_URI=$gitlab_oauth_redirect_uri" \
      "REVIEW_DRY_RUN=$REVIEW_DRY_RUN" \
      "REVIEW_SERVICE_TOKEN=$REVIEW_SERVICE_TOKEN" \
      "GITLAB_WEBHOOK_SECRET=$GITLAB_WEBHOOK_SECRET" \
      "$NODE_BIN" "${NODE_ENV_FILE_ARGS[@]}" "$TSX_BIN" watch "$ROOT_DIR/src/server.ts"
    printf 'screen:%s\n' "$API_SESSION"
    return 0
  fi

  (
    cd "$ROOT_DIR"
    exec nohup env \
      HOST="$API_HOST" \
      PORT="$API_PORT" \
      WEB_ORIGIN="$WEB_ORIGIN" \
      GITLAB_OAUTH_REDIRECT_URI="$gitlab_oauth_redirect_uri" \
      REVIEW_DRY_RUN="$REVIEW_DRY_RUN" \
      REVIEW_SERVICE_TOKEN="$REVIEW_SERVICE_TOKEN" \
      GITLAB_WEBHOOK_SECRET="$GITLAB_WEBHOOK_SECRET" \
      "$NODE_BIN" "${NODE_ENV_FILE_ARGS[@]}" "$TSX_BIN" watch "$ROOT_DIR/src/server.ts"
  ) >> "$API_LOG_FILE" 2>&1 < /dev/null &
  local pid=$!
  printf '%s\n' "$pid" > "$API_PID_FILE"
  printf 'pid:%s\n' "$pid"
}

start_web() {
  if screen_session_exists "$WEB_SESSION"; then
    echo "Web is already running (screen session $WEB_SESSION)." >&2
    printf 'screen:%s\n' "$WEB_SESSION"
    return 0
  fi

  local existing_pid
  existing_pid="$(read_pid "$WEB_PID_FILE" 2>/dev/null || true)"
  if [[ -n "$existing_pid" ]] && is_managed_web "$existing_pid"; then
    echo "Web is already running (pid $existing_pid)." >&2
    printf 'pid:%s\n' "$existing_pid"
    return 0
  fi
  rm -f "$WEB_PID_FILE"

  if ! ensure_port_available "$WEB_PORT" is_managed_web MR_REVIEW_WEB_PORT; then
    return 1
  fi
  : > "$WEB_LOG_FILE"
  if [[ -n "$SCREEN_BIN" ]]; then
    screen_start "$WEB_SESSION" "$WEB_LOG_FILE" "$ROOT_DIR/apps/web" \
      env \
      "VITE_API_PROXY_TARGET=$VITE_API_PROXY_TARGET" \
      "$NODE_BIN" "${NODE_ENV_FILE_ARGS[@]}" "$VITE_BIN" --host "$WEB_HOST" --port "$WEB_PORT" --strictPort
    printf 'screen:%s\n' "$WEB_SESSION"
    return 0
  fi

  (
    cd "$ROOT_DIR/apps/web"
    exec nohup env \
      VITE_API_PROXY_TARGET="$VITE_API_PROXY_TARGET" \
      "$NODE_BIN" "${NODE_ENV_FILE_ARGS[@]}" "$VITE_BIN" --host "$WEB_HOST" --port "$WEB_PORT" --strictPort
  ) >> "$WEB_LOG_FILE" 2>&1 < /dev/null &
  local pid=$!
  printf '%s\n' "$pid" > "$WEB_PID_FILE"
  printf 'pid:%s\n' "$pid"
}

start_server() {
  load_node
  if [[ ! -x "$TSX_BIN" || ! -x "$VITE_BIN" ]]; then
    echo "Dependencies are not installed. Run: npm install" >&2
    return 1
  fi

  mkdir -p "$STATE_DIR"

  local env_file_review_dry_run env_file_service_token env_file_webhook_secret
  env_file_review_dry_run="$(env_file_value REVIEW_DRY_RUN)"
  env_file_service_token="$(env_file_value REVIEW_SERVICE_TOKEN)"
  env_file_webhook_secret="$(env_file_value GITLAB_WEBHOOK_SECRET)"
  export REVIEW_DRY_RUN="${REVIEW_DRY_RUN:-${env_file_review_dry_run:-true}}"
  export REVIEW_SERVICE_TOKEN="${REVIEW_SERVICE_TOKEN:-${env_file_service_token:-local-trigger-token}}"
  export GITLAB_WEBHOOK_SECRET="${GITLAB_WEBHOOK_SECRET:-${env_file_webhook_secret:-local-webhook-secret}}"

  resolve_ports
  if [[ -z "$WEB_ORIGIN" ]]; then
    WEB_ORIGIN="http://${WEB_HOST}:${WEB_PORT}"
  fi
  if [[ -z "$VITE_API_PROXY_TARGET" ]]; then
    VITE_API_PROXY_TARGET="http://127.0.0.1:${API_PORT}"
  fi
  local gitlab_oauth_redirect_uri="${GITLAB_OAUTH_REDIRECT_URI:-${WEB_ORIGIN}/api/v1/gitlab/oauth/callback}"

  # Check every required port before starting either service. This keeps a
  # failed start from leaving only the API running when the web port is busy.
  preflight_ports
  write_port_state

  local api_pid web_pid
  if ! api_pid="$(start_api "$gitlab_oauth_redirect_uri")"; then
    return 1
  fi
  if ! web_pid="$(start_web)"; then
    stop_service "API" "$API_PID_FILE" is_managed_api "$API_SESSION"
    return 1
  fi

  if ! wait_for_url "http://$API_HOST:$API_PORT/healthz" "$api_pid" "API"; then
    stop_service "API" "$API_PID_FILE" is_managed_api "$API_SESSION"
    stop_service "Web" "$WEB_PID_FILE" is_managed_web "$WEB_SESSION"
    show_logs "$API_LOG_FILE"
    return 1
  fi
  if ! wait_for_url "http://$WEB_HOST:$WEB_PORT/" "$web_pid" "Web"; then
    stop_service "API" "$API_PID_FILE" is_managed_api "$API_SESSION"
    stop_service "Web" "$WEB_PID_FILE" is_managed_web "$WEB_SESSION"
    show_logs "$WEB_LOG_FILE"
    return 1
  fi

  echo "Frontend Pilot started."
  echo "Web: http://$WEB_HOST:$WEB_PORT"
  echo "API: http://$API_HOST:$API_PORT"
  echo "Logs: $STATE_DIR"
}

stop_server() {
  stop_service "API" "$API_PID_FILE" is_managed_api "$API_SESSION"
  stop_service "Web" "$WEB_PID_FILE" is_managed_web "$WEB_SESSION"
}

restart_server() {
  # Resolve automatic ports before stopping anything. Existing processes
  # belonging to this project are preferred and are allowed by the checkers.
  resolve_ports
  if ! preflight_ports; then
    echo "Restart aborted; running services were left untouched." >&2
    return 1
  fi
  mkdir -p "$STATE_DIR"
  write_port_state
  stop_server
  start_server
}

usage() {
  echo "Usage: $0 {start|restart|stop}" >&2
}

main() {
  case "${1:-}" in
    start)
      start_server
      ;;
    restart)
      restart_server
      ;;
    stop)
      stop_server
      ;;
    *)
      usage
      return 1
      ;;
  esac
}

main "$@"
