#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/deploy/compose/docker-compose.yaml"
LOCAL_COMPOSE_FILE="$ROOT_DIR/deploy/compose/docker-compose.local-smoke.yaml"
LOCAL_GITHUB_COMPOSE_FILE="$ROOT_DIR/deploy/compose/docker-compose.local-github-smoke.yaml"
WORK_DIR="${WORK_DIR:-/tmp/mcp-gw-local-integration}"
JWKS_PORT="${JWKS_PORT:-18080}"
GATEWAY_PORT="${GATEWAY_PORT:-18081}"
ISSUER="http://host.docker.internal:$JWKS_PORT"
AUDIENCE="http://agentgateway:3000/mcp"
TOKEN_FILE="$WORK_DIR/hop1.jwt"
ENV_FILE="$WORK_DIR/compose.env"
INCLUDE_GITHUB="${LOCAL_INCLUDE_GITHUB:-0}"
COMPOSE_ARGS=(-f "$COMPOSE_FILE" -f "$LOCAL_COMPOSE_FILE")
COMPOSE_PROFILES=()
COMPOSE_SERVICES=(token-store google-workspace agentgateway)

mkdir -p "$WORK_DIR"

compose_cmd() {
  if [[ ${#COMPOSE_PROFILES[@]} -gt 0 ]]; then
    docker compose --env-file "$ENV_FILE" "${COMPOSE_ARGS[@]}" "${COMPOSE_PROFILES[@]}" "$@"
  else
    docker compose --env-file "$ENV_FILE" "${COMPOSE_ARGS[@]}" "$@"
  fi
}

cleanup() {
  if [[ "${KEEP_LOCAL_INTEGRATION:-0}" != "1" ]]; then
    compose_cmd down --remove-orphans >/dev/null 2>&1 || true
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
  if [[ -s "$TOKEN_FILE" ]] && curl -sS "$ISSUER/health" >/dev/null 2>&1; then
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
AGENTGATEWAY_IMAGE=${LOCAL_AGENTGATEWAY_IMAGE:-ghcr.io/agentgateway/agentgateway:v1.2.0}
HOP1_PROFILE=local
HOP1_ISSUER=$ISSUER
HOP1_JWKS_URL=$ISSUER/.well-known/jwks.json
HOP1_AUDIENCE=$AUDIENCE
HOP1_OAUTH_SCOPES=openid email
HOP1_EMAIL_CLAIM=email
HOP1_SUBJECT_CLAIM=sub
GOOGLE_OAUTH_CLIENT_ID=local-client
GOOGLE_OAUTH_CLIENT_SECRET=local-secret
GOOGLE_OAUTH_REDIRECT_URI=http://127.0.0.1:$GATEWAY_PORT/oauth/google/callback
GOOGLE_TOKEN_ENCRYPTION_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=
GWS_BINARY_PATH=/app/node_modules/.bin/gws
TOKEN_STORE_DSN=postgres://mcp:mcp@token-store:5432/mcp
GITHUB_TOKEN_ENCRYPTION_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=
GITHUB_OAUTH_CLIENT_ID=local-github-client
GITHUB_OAUTH_CLIENT_SECRET=local-github-secret
GITHUB_OAUTH_REDIRECT_URI=http://127.0.0.1:$GATEWAY_PORT/oauth/github/callback
ENV

EXPECTED_TOOLS=("google_oauth_start")
if [[ "$INCLUDE_GITHUB" == "1" ]]; then
  COMPOSE_ARGS+=(-f "$LOCAL_GITHUB_COMPOSE_FILE" -f "$ROOT_DIR/deploy/compose/docker-compose.github-mcp.yaml")
  COMPOSE_PROFILES+=(--profile github-mcp)
  COMPOSE_SERVICES+=(github-mcp github-wrapper)
  EXPECTED_TOOLS+=("github_oauth_start")
fi

has_expected_tools() {
  for expected_tool in "${EXPECTED_TOOLS[@]}"; do
    if ! grep -q "$expected_tool" "$RESPONSE_FILE"; then
      return 1
    fi
  done
}

compose_cmd config >/dev/null
compose_cmd up -d --build "${COMPOSE_SERVICES[@]}"

TOKEN="$(cat "$TOKEN_FILE")"
INITIALIZE_PAYLOAD='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"mcp-gw-local-smoke","version":"0.1.0"}}}'
TOOLS_PAYLOAD='{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
HEADERS_FILE="$WORK_DIR/initialize.headers"
INITIALIZE_RESPONSE_FILE="$WORK_DIR/initialize.json"
RESPONSE_FILE="$WORK_DIR/tools-list.json"
rm -f "$HEADERS_FILE" "$INITIALIZE_RESPONSE_FILE" "$RESPONSE_FILE"

for _ in {1..60}; do
  http_code="$(
    curl -sS -D "$HEADERS_FILE" -o "$INITIALIZE_RESPONSE_FILE" -w "%{http_code}" \
      -X POST "http://127.0.0.1:$GATEWAY_PORT/mcp" \
      -H "authorization: Bearer $TOKEN" \
      -H "accept: application/json, text/event-stream" \
      -H "content-type: application/json" \
      -H "mcp-protocol-version: 2025-06-18" \
      --data "$INITIALIZE_PAYLOAD" || true
  )"

  SESSION_ID="$(
    awk 'tolower($1) == "mcp-session-id:" { value=$2; gsub("\r", "", value); print value }' "$HEADERS_FILE" || true
  )"

  if [[ "$http_code" != "200" ]] || [[ -z "$SESSION_ID" ]]; then
    sleep 2
    continue
  fi

  http_code="$(
    curl -sS -o "$RESPONSE_FILE" -w "%{http_code}" \
      -X POST "http://127.0.0.1:$GATEWAY_PORT/mcp" \
      -H "authorization: Bearer $TOKEN" \
      -H "accept: application/json, text/event-stream" \
      -H "content-type: application/json" \
      -H "mcp-protocol-version: 2025-06-18" \
      -H "mcp-session-id: $SESSION_ID" \
      --data "$TOOLS_PAYLOAD" || true
  )"

  if [[ "$INCLUDE_GITHUB" != "1" ]] && [[ "$http_code" == "200" ]] && grep -q "google_google_" "$RESPONSE_FILE"; then
    echo "Local integration smoke failed: Google-only route unexpectedly double-prefixed tools." >&2
    cat "$RESPONSE_FILE" >&2 || true
    exit 1
  fi

  if [[ "$http_code" == "200" ]] && has_expected_tools; then
    if [[ "$INCLUDE_GITHUB" == "1" ]]; then
      echo "Local integration smoke passed: tools/list reached GitHub OAuth helpers through agentgateway."
    else
      echo "Local integration smoke passed: tools/list reached Google OAuth helpers through agentgateway."
    fi
    exit 0
  fi

  sleep 2
done

echo "Local integration smoke failed: expected ${EXPECTED_TOOLS[*]} through gateway." >&2
echo "Last response:" >&2
cat "$RESPONSE_FILE" >&2 || true
echo >&2
compose_cmd logs --tail=100 >&2 || true
exit 1
