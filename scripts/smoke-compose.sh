#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/deploy/compose/docker-compose.yaml"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/deploy/compose/.env}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing env file: $ENV_FILE" >&2
  echo "Create it from deploy/compose/.env.example." >&2
  exit 1
fi

docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" config >/dev/null
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d token-store google-workspace

BASE_URL="${GOOGLE_WORKSPACE_URL:-http://127.0.0.1:8080}"
for _ in {1..30}; do
  status="$(curl -sS -o /dev/null -w '%{http_code}' "$BASE_URL/oauth/google/status" || true)"
  if [[ "$status" == "401" ]]; then
    echo "Smoke passed: oauth status requires bearer auth."
    exit 0
  fi
  sleep 1
done

echo "Smoke failed: expected 401 from $BASE_URL/oauth/google/status" >&2
exit 1

