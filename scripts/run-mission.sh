#!/usr/bin/env bash
#
# run-mission.sh — (re)run Operation Echo Shield by asking the Command Agent
# to start the mission. The command agent re-orchestrates every hop and
# re-persists the timeline.
#
set -euo pipefail

# Pick up host-port overrides from the repo .env (if present).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/../.env"
# shellcheck disable=SC1090
[[ -f "${ENV_FILE}" ]] && { set -a; . "${ENV_FILE}"; set +a; }

COMMAND_AGENT_URL="${COMMAND_AGENT_URL:-http://localhost:${COMMAND_HOST_PORT:-8001}}"
DEMO_TOKEN="${A2A_DEMO_TOKEN:-resistance-demo-token}"

echo "==> Triggering Operation Echo Shield at ${COMMAND_AGENT_URL}/mission:start ..."

HTTP_STATUS="$(curl -sS -o /tmp/run-mission-body.$$ -w '%{http_code}' \
	-X POST "${COMMAND_AGENT_URL}/mission:start" \
	-H "Content-Type: application/json" \
	-H "X-Demo-Token: ${DEMO_TOKEN}" \
	-H "A2A-Version: 1.0" \
	-d '{}' )"

BODY="$(cat /tmp/run-mission-body.$$ 2>/dev/null || true)"
rm -f /tmp/run-mission-body.$$

echo "    HTTP ${HTTP_STATUS}"
if [[ -n "${BODY}" ]]; then
	echo "${BODY}" | python3 -m json.tool 2>/dev/null || echo "${BODY}"
fi

if [[ "${HTTP_STATUS}" -ge 200 && "${HTTP_STATUS}" -lt 300 ]]; then
	echo "==> Mission started. Watch it unfold at http://localhost:8080"
else
	echo "!!! Mission start failed (HTTP ${HTTP_STATUS})." >&2
	exit 1
fi
