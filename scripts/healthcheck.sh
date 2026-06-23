#!/usr/bin/env bash
#
# healthcheck.sh — curl GET /health on all 8 services on their host ports and
# print OK/FAIL for each. Exits non-zero if any service is unhealthy.
#
set -euo pipefail

# Pick up host-port overrides from the repo .env (if present).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/../.env"
# shellcheck disable=SC1090
[[ -f "${ENV_FILE}" ]] && { set -a; . "${ENV_FILE}"; set +a; }

HOST="${A2A_HOST:-localhost}"

# name|port  — the 8 services, on their host-mapped ports (override via *_HOST_PORT).
SERVICES=(
	"agent-registry|${REGISTRY_HOST_PORT:-8000}"
	"resistance-command-agent|${COMMAND_HOST_PORT:-8001}"
	"dashboard-api|${DASHBOARD_HOST_PORT:-8080}"
	"intelligence-agent|${INTEL_HOST_PORT:-8011}"
	"communications-relay-agent|${RELAY_HOST_PORT:-8012}"
	"tactical-agent|${TACTICAL_HOST_PORT:-8021}"
	"logistics-agent|${LOGISTICS_HOST_PORT:-8022}"
	"fleet-agent|${FLEET_HOST_PORT:-8023}"
)

FAILED=0
PASSED=0

echo "==> Health check across all services on ${HOST}"
echo ""

for entry in "${SERVICES[@]}"; do
	name="${entry%%|*}"
	port="${entry##*|}"
	url="http://${HOST}:${port}/health"

	code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "${url}" 2>/dev/null || echo "000")"

	if [[ "${code}" == "200" ]]; then
		printf '  [ OK ] %-28s :%s  (HTTP %s)\n' "${name}" "${port}" "${code}"
		PASSED=$((PASSED + 1))
	else
		printf '  [FAIL] %-28s :%s  (HTTP %s)\n' "${name}" "${port}" "${code}"
		FAILED=$((FAILED + 1))
	fi
done

echo ""
echo "==> ${PASSED} healthy, ${FAILED} failed."

if [[ "${FAILED}" -gt 0 ]]; then
	exit 1
fi
