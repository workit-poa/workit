#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

LOCAL_NODE_REPO_URL="${HEDERA_LOCAL_NODE_REPO_URL:-https://github.com/hiero-ledger/hiero-local-node.git}"
LOCAL_NODE_REPO_REF="${HEDERA_LOCAL_NODE_REPO_REF:-main}"
LOCAL_NODE_DIR="${HEDERA_LOCAL_NODE_DIR:-${SCRIPT_DIR}/hiero-local-node}"

CACHE_DIR="${SCRIPT_DIR}/.cache"
START_LOG="${CACHE_DIR}/start.log"
DOCKER_LOG="${CACHE_DIR}/docker.log"

KEYS_ENV_FILE="${HEDERA_LOCAL_KEYS_ENV_FILE:-${WORKSPACE_ROOT}/libs/contracts/.env.local}"

MIRROR_REST_URL="${HEDERA_LOCAL_MIRROR_REST_URL:-http://localhost:5551}"
RPC_URL="${HEDERA_LOCAL_RPC_URL:-http://localhost:7546}"

usage() {
  cat <<EOF
Usage: $(basename "$0") <command>

Commands:
  start    Clone (if needed) and start Hiero local node in detached mode
  stop     Stop local node containers
  logs     Stream docker compose logs from local node directory
  status   Quick health checks (mirror REST + JSON-RPC latest block)
  keys     Extract funded accounts/private keys into libs/contracts/.env.local
EOF
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

ensure_local_node_repo() {
  if [ ! -d "${LOCAL_NODE_DIR}/.git" ]; then
    echo "Cloning Hiero local node into ${LOCAL_NODE_DIR}"
    mkdir -p "$(dirname "${LOCAL_NODE_DIR}")"
    git clone --depth 1 --branch "${LOCAL_NODE_REPO_REF}" "${LOCAL_NODE_REPO_URL}" "${LOCAL_NODE_DIR}"
  fi
}

ensure_local_node_deps() {
  if [ ! -d "${LOCAL_NODE_DIR}/node_modules" ]; then
    echo "Installing local node dependencies"
    (
      cd "${LOCAL_NODE_DIR}"
      npm install
    )
  fi
}

extract_keys_from_log() {
  local log_file="$1"
  [ -f "${log_file}" ] || return 1

  node "${SCRIPT_DIR}/scripts/extract-funded-accounts.mjs" \
    --log "${log_file}" \
    --out "${KEYS_ENV_FILE}"
}

collect_docker_logs() {
  require_cmd docker
  docker info >/dev/null 2>&1 || return 1
  mkdir -p "${CACHE_DIR}"
  : > "${DOCKER_LOG}"

  local names
  names="$(docker ps --format '{{.Names}}' | grep -E 'hiero|hedera|mirror|relay|consensus|network-node' || true)"
  [ -n "${names}" ] || return 1

  while IFS= read -r name; do
    docker logs "${name}" >> "${DOCKER_LOG}" 2>&1 || true
  done <<< "${names}"
}

cmd_start() {
  require_cmd git
  require_cmd npm
  ensure_local_node_repo
  ensure_local_node_deps

  mkdir -p "${CACHE_DIR}"
  echo "Starting Hiero local node in detached mode..."
  (
    cd "${LOCAL_NODE_DIR}"
    npm run start -- -d 2>&1 | tee "${START_LOG}"
  )

  if ! extract_keys_from_log "${START_LOG}"; then
    echo "Could not extract funded keys from start logs yet. Run 'pnpm hedera:local:keys' once startup logs are available."
  fi
}

cmd_stop() {
  require_cmd npm
  if [ ! -d "${LOCAL_NODE_DIR}" ]; then
    echo "Local node directory not found at ${LOCAL_NODE_DIR}; nothing to stop."
    return 0
  fi

  (
    cd "${LOCAL_NODE_DIR}"
    npm run stop
  )
}

cmd_logs() {
  if [ -d "${LOCAL_NODE_DIR}" ] && command -v docker >/dev/null 2>&1; then
    (
      cd "${LOCAL_NODE_DIR}"
      docker compose logs --tail=200 -f
    )
    return 0
  fi

  if [ -f "${START_LOG}" ]; then
    tail -n 200 -f "${START_LOG}"
    return 0
  fi

  echo "No logs available yet. Start the local node first."
}

cmd_status() {
  require_cmd curl

  local failed=0

  echo "Checking mirror REST: ${MIRROR_REST_URL}/api/v1/accounts?limit=1"
  if curl -fsS "${MIRROR_REST_URL}/api/v1/accounts?limit=1" >/dev/null; then
    echo "  mirror REST: OK"
  else
    echo "  mirror REST: FAILED"
    failed=1
  fi

  echo "Checking JSON-RPC: ${RPC_URL} (eth_getBlockByNumber latest)"
  local payload response block_hex
  payload='{"jsonrpc":"2.0","method":"eth_getBlockByNumber","params":["latest",false],"id":1}'
  response="$(curl -fsS "${RPC_URL}" -H "content-type: application/json" --data "${payload}" || true)"
  block_hex="$(printf "%s" "${response}" | sed -n 's/.*"number":"\([^"]*\)".*/\1/p')"

  if [ -n "${block_hex}" ]; then
    echo "  json-rpc: OK (latest block ${block_hex})"
  else
    echo "  json-rpc: FAILED"
    failed=1
  fi

  if [ "${failed}" -ne 0 ]; then
    exit 1
  fi
}

cmd_keys() {
  mkdir -p "${CACHE_DIR}"

  if extract_keys_from_log "${START_LOG}"; then
    return 0
  fi

  if collect_docker_logs && extract_keys_from_log "${DOCKER_LOG}"; then
    return 0
  fi

  echo "Unable to extract funded keys automatically."
  echo "Check 'pnpm hedera:local:logs' and copy two funded ECDSA private keys into libs/contracts/.env.local."
  exit 1
}

main() {
  local cmd="${1:-}"
  case "${cmd}" in
    start)
      cmd_start
      ;;
    stop)
      cmd_stop
      ;;
    logs)
      cmd_logs
      ;;
    status)
      cmd_status
      ;;
    keys)
      cmd_keys
      ;;
    *)
      usage
      exit 1
      ;;
  esac
}

main "$@"
