#!/usr/bin/env bash
#
# reset-db.sh — wipe the shared SQLite volume so the mission DB is recreated
# from scratch, then bring the stack back up. Use this when you want a clean
# Operation Echo Shield run with no persisted history.
#
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

COMPOSE="docker compose"

# The docker-compose project is named "starwars-a2a" and the volume is "a2a-data",
# so the actual docker volume is "starwars-a2a_a2a-data". We let compose resolve it.
VOLUME_NAME="a2a-data"

echo "==> Stopping the stack..."
${COMPOSE} down

echo "==> Removing the ${VOLUME_NAME} volume (the mission DB)..."
# `docker compose down -v` would also wipe other volumes; we target only a2a-data.
# Resolve the fully-qualified volume name (project prefix) and remove it directly.
PROJECT_NAME="$(${COMPOSE} config --format json 2>/dev/null \
	| python3 -c 'import json,sys; print(json.load(sys.stdin).get("name",""))' 2>/dev/null || true)"

if [[ -z "${PROJECT_NAME}" ]]; then
	PROJECT_NAME="starwars-a2a"
fi

FQ_VOLUME="${PROJECT_NAME}_${VOLUME_NAME}"

if docker volume inspect "${FQ_VOLUME}" >/dev/null 2>&1; then
	docker volume rm "${FQ_VOLUME}"
	echo "    removed volume ${FQ_VOLUME}"
else
	echo "    volume ${FQ_VOLUME} not found (already clean)"
fi

echo "==> Restarting the stack (DB will be recreated)..."
${COMPOSE} up --build -d

echo "==> Done. The galaxy is online again with a fresh database."
echo "    Dashboard: http://localhost:8080"
