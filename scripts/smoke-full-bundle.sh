#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/deploy/compose/docker-compose.full-bundle-smoke.yaml"
WORK_DIR="${WORK_DIR:-/tmp/mcp-gw-full-bundle-integration}"
JWKS_PORT="${JWKS_PORT:-18180}"
GATEWAY_PORT="${GATEWAY_PORT:-18181}"
GOOGLE_WRAPPER_PORT="${GOOGLE_WRAPPER_PORT:-18182}"
GITHUB_WRAPPER_PORT="${GITHUB_WRAPPER_PORT:-18183}"
ISSUER="http://host.docker.internal:$JWKS_PORT"
AUDIENCE="http://agentgateway:3000/mcp"
TOKEN_FILE="$WORK_DIR/hop1.jwt"
ENV_FILE="$WORK_DIR/compose.env"
LOG_FILE="$WORK_DIR/compose.log"

mkdir -p "$WORK_DIR"

compose_cmd() {
  docker compose --project-name mcp-gw-full-bundle-smoke \
    --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

cleanup() {
  if [[ "${KEEP_FULL_BUNDLE_INTEGRATION:-0}" != "1" ]] && [[ -s "$ENV_FILE" ]]; then
    compose_cmd down --remove-orphans --volumes >/dev/null 2>&1 || true
  fi
  if [[ -n "${FIXTURE_PID:-}" ]]; then
    kill "$FIXTURE_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

bun "$ROOT_DIR/scripts/fixtures/hop1-fixture.ts" \
  --port "$JWKS_PORT" \
  --issuer "$ISSUER" \
  --audience "$AUDIENCE" \
  --token-file "$TOKEN_FILE" \
  >"$WORK_DIR/hop1-fixture.log" 2>&1 &
FIXTURE_PID=$!

for _ in {1..30}; do
  if [[ -s "$TOKEN_FILE" ]] && curl -sS "http://127.0.0.1:$JWKS_PORT/health" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
if [[ ! -s "$TOKEN_FILE" ]]; then
  echo "HOP-1 fixture did not produce a token." >&2
  cat "$WORK_DIR/hop1-fixture.log" >&2 || true
  exit 1
fi

cat >"$ENV_FILE" <<ENV
GATEWAY_PORT=$GATEWAY_PORT
GOOGLE_WRAPPER_PORT=$GOOGLE_WRAPPER_PORT
GITHUB_WRAPPER_PORT=$GITHUB_WRAPPER_PORT
AGENTGATEWAY_IMAGE=${LOCAL_AGENTGATEWAY_IMAGE:-ghcr.io/apelogic-ai/mcp-gw-agentgateway:0.2.6}
ENV

compose_cmd config >/dev/null
compose_cmd up -d --build token-store provider-fixture
compose_cmd build oauth-migrations

# Two simultaneous runs prove the advisory lock makes migration execution concurrency-safe.
compose_cmd run --rm --no-deps oauth-migrations &
MIGRATION_PID_ONE=$!
compose_cmd run --rm --no-deps oauth-migrations &
MIGRATION_PID_TWO=$!
wait "$MIGRATION_PID_ONE"
wait "$MIGRATION_PID_TWO"

compose_cmd up -d --build google-workspace github-wrapper agentgateway

TOKEN="$(cat "$TOKEN_FILE")"
INITIALIZE_PAYLOAD='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"full-bundle-smoke","version":"1.0.0"}}}'

auth_status() {
  local candidate="${1:-}"
  local headers=(
    -H "accept: application/json, text/event-stream"
    -H "content-type: application/json"
    -H "mcp-protocol-version: 2025-06-18"
  )
  if [[ -n "$candidate" ]]; then
    headers+=(-H "authorization: Bearer $candidate")
  fi
  curl -sS -o /dev/null -w "%{http_code}" \
    -X POST "http://127.0.0.1:$GATEWAY_PORT/mcp" \
    "${headers[@]}" \
    --data "$INITIALIZE_PAYLOAD" || true
}

for _ in {1..60}; do
  if [[ "$(auth_status "$TOKEN")" == "200" ]]; then
    break
  fi
  sleep 2
done
if [[ "$(auth_status "$TOKEN")" != "200" ]]; then
  echo "Full bundle gateway did not become ready." >&2
  compose_cmd logs --tail=200 >&2 || true
  exit 1
fi

[[ "$(auth_status)" == "401" ]]
for label in expired missing-expiration wrong-issuer wrong-audience invalid-signature wrong-algorithm not-before; do
  [[ "$(auth_status "$(cat "$TOKEN_FILE.$label")")" == "401" ]]
done

bun "$ROOT_DIR/scripts/fixtures/full-bundle-client.ts" \
  --gateway-url "http://127.0.0.1:$GATEWAY_PORT/mcp" \
  --token-file "$TOKEN_FILE" \
  --google-callback-url "http://127.0.0.1:$GOOGLE_WRAPPER_PORT/oauth/google/callback" \
  --github-callback-url "http://127.0.0.1:$GITHUB_WRAPPER_PORT/oauth/github/callback"

compose_cmd logs --no-color >"$LOG_FILE"

assert_logs_do_not_contain_credentials() {
  local credential
  for credential in \
    "$TOKEN" \
    fixture-google-provider-token \
    fixture-google-refresh-token \
    fixture-github-provider-token; do
    if grep -Fq "$credential" "$LOG_FILE"; then
      echo "Credential material appeared in full-bundle logs." >&2
      exit 1
    fi
  done
}

assert_logs_do_not_contain_credentials
echo "Full bundle integration smoke passed."
