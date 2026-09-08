#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK_DIR="${EXTERNAL_WORK_DIR:-/tmp/mcp-gw-external-issuer-integration}"
# This port is part of the checked-in AgentGateway fixture configuration.
JWKS_PORT="38080"
GOOGLE_WRAPPER_PORT="${EXTERNAL_GOOGLE_WRAPPER_PORT:-38083}"
GITHUB_WRAPPER_PORT="${EXTERNAL_GITHUB_WRAPPER_PORT:-38085}"
GATEWAY_PORT="${EXTERNAL_GATEWAY_PORT:-38081}"
TOKEN_STORE_PORT="${EXTERNAL_TOKEN_STORE_PORT:-35432}"
ISSUER="http://host.docker.internal:$JWKS_PORT"
AUDIENCE="https://mcp.example.com/mcp"
TOKEN_FILE="$WORK_DIR/hop1.jwt"
ENV_FILE="$WORK_DIR/compose.env"
COMPOSE_ARGS=(
  -f "$ROOT_DIR/deploy/compose/docker-compose.yaml"
  -f "$ROOT_DIR/deploy/compose/docker-compose.github-mcp.yaml"
  -f "$ROOT_DIR/deploy/compose/docker-compose.external-issuer-smoke.yaml"
  --profile github-mcp
)

mkdir -p "$WORK_DIR"
rm -f "$TOKEN_FILE" "$TOKEN_FILE".*

compose_cmd() {
  docker compose --env-file "$ENV_FILE" "${COMPOSE_ARGS[@]}" "$@"
}

cleanup() {
  if [[ "${KEEP_EXTERNAL_INTEGRATION:-0}" != "1" ]]; then
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
  --email-claim "mail" \
  --subject-claim "oid" \
  >"$WORK_DIR/hop1-fixture.log" 2>&1 &
FIXTURE_PID=$!

for _ in {1..30}; do
  if [[ -s "$TOKEN_FILE" ]] && curl -sS "http://127.0.0.1:$JWKS_PORT/health" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
if [[ ! -s "$TOKEN_FILE" ]]; then
  echo "External HOP-1 fixture did not produce a token." >&2
  cat "$WORK_DIR/hop1-fixture.log" >&2 || true
  exit 1
fi

cat >"$ENV_FILE" <<ENV
GATEWAY_PORT=$GATEWAY_PORT
TOKEN_STORE_PORT=$TOKEN_STORE_PORT
GOOGLE_WRAPPER_PORT=$GOOGLE_WRAPPER_PORT
GITHUB_WRAPPER_PORT=$GITHUB_WRAPPER_PORT
AGENTGATEWAY_IMAGE=${LOCAL_AGENTGATEWAY_IMAGE:-ghcr.io/apelogic-ai/mcp-gw-agentgateway:0.4.7}
MCP_BROKER_ENABLED=false
HOP1_PROFILE=external
HOP1_ISSUER=$ISSUER
HOP1_JWKS_URL=$ISSUER/.well-known/jwks.json
HOP1_AUDIENCE=$AUDIENCE
HOP1_ALLOWED_ALGORITHMS=RS256
HOP1_OAUTH_SCOPES=openid email
HOP1_EMAIL_CLAIM=mail
HOP1_SUBJECT_CLAIM=oid
EXTERNAL_HOP1_ISSUERS_JSON=[{"name":"external","issuer":"$ISSUER","jwksUrl":"$ISSUER/.well-known/jwks.json","audiences":["$AUDIENCE"],"allowedAlgorithms":["RS256"],"emailClaim":"mail","subjectClaim":"oid"}]
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

compose_cmd config >/dev/null
compose_cmd up -d --build token-store google-workspace github-mcp github-wrapper agentgateway

MIGRATION_LOG="$WORK_DIR/oauth-migrations.log"
for _ in {1..30}; do
  if TOKEN_STORE_DSN="postgres://mcp:mcp@127.0.0.1:$TOKEN_STORE_PORT/mcp" \
    bun "$ROOT_DIR/shared/oauth/migrate.ts" >"$MIGRATION_LOG" 2>&1; then
    MIGRATION_READY=1
    break
  fi
  sleep 1
done
if [[ "${MIGRATION_READY:-0}" != "1" ]]; then
  echo "External issuer integration failed: OAuth migrations did not complete." >&2
  cat "$MIGRATION_LOG" >&2 || true
  exit 1
fi

for _ in {1..60}; do
  if bun "$ROOT_DIR/scripts/fixtures/external-issuer-journey-client.ts" \
    --gateway-url "http://127.0.0.1:$GATEWAY_PORT/mcp" \
    --google-wrapper-url "http://127.0.0.1:$GOOGLE_WRAPPER_PORT/mcp" \
    --github-wrapper-url "http://127.0.0.1:$GITHUB_WRAPPER_PORT/mcp" \
    --token-file "$TOKEN_FILE"; then
    exit 0
  fi
  sleep 2
done

echo "External issuer integration failed after waiting for the full bundle." >&2
compose_cmd logs --tail=100 >&2 || true
exit 1
