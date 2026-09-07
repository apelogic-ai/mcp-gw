#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/deploy/compose/docker-compose.yaml"
LOCAL_COMPOSE_FILE="$ROOT_DIR/deploy/compose/docker-compose.local-smoke.yaml"
LOCAL_GITHUB_COMPOSE_FILE="$ROOT_DIR/deploy/compose/docker-compose.local-github-smoke.yaml"
WORK_DIR="${WORK_DIR:-/tmp/mcp-gw-local-integration}"
JWKS_PORT="${JWKS_PORT:-38080}"
BROKER_JWKS_PORT="${BROKER_JWKS_PORT:-38082}"
GOOGLE_WRAPPER_PORT="${GOOGLE_WRAPPER_PORT:-38083}"
GITHUB_WRAPPER_PORT="${GITHUB_WRAPPER_PORT:-38085}"
GOOGLE_OIDC_PORT="${GOOGLE_OIDC_PORT:-38084}"
GATEWAY_PORT="${GATEWAY_PORT:-38081}"
TOKEN_STORE_PORT="${TOKEN_STORE_PORT:-35432}"
ISSUER="http://host.docker.internal:$JWKS_PORT"
FIXTURE_BASE_URL="http://127.0.0.1:$JWKS_PORT"
BROKER_ISSUER_INPUT="https://mcp.example.com/oauth/"
BROKER_ISSUER="${BROKER_ISSUER_INPUT%/}"
BROKER_FIXTURE_BASE_URL="http://127.0.0.1:$BROKER_JWKS_PORT"
BROKER_BASE_URL="http://127.0.0.1:$GOOGLE_WRAPPER_PORT/oauth"
GOOGLE_OIDC_FIXTURE_BASE_URL="http://127.0.0.1:$GOOGLE_OIDC_PORT"
AUDIENCE="https://mcp.example.com/mcp"
TOKEN_FILE="$WORK_DIR/hop1.jwt"
BROKER_TOKEN_FILE="$WORK_DIR/broker.jwt"
BROKER_SIGNING_JWKS_DIR="$WORK_DIR/broker"
BROKER_SIGNING_JWKS_FILE="$BROKER_SIGNING_JWKS_DIR/signing-jwks.json"
ENV_FILE="$WORK_DIR/compose.env"
INCLUDE_GITHUB="${LOCAL_INCLUDE_GITHUB:-0}"
COMPOSE_ARGS=(-f "$COMPOSE_FILE" -f "$LOCAL_COMPOSE_FILE")
COMPOSE_PROFILES=()
COMPOSE_SERVICES=(token-store google-workspace agentgateway)

mkdir -p "$WORK_DIR" "$BROKER_SIGNING_JWKS_DIR"
chmod 700 "$BROKER_SIGNING_JWKS_DIR"
rm -f "$TOKEN_FILE" "$TOKEN_FILE".* "$BROKER_TOKEN_FILE" "$BROKER_TOKEN_FILE".* \
  "$BROKER_SIGNING_JWKS_FILE"

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
  if [[ -n "${BROKER_FIXTURE_PID:-}" ]]; then
    kill "$BROKER_FIXTURE_PID" >/dev/null 2>&1 || true
  fi
  if [[ -n "${GOOGLE_OIDC_FIXTURE_PID:-}" ]]; then
    kill "$GOOGLE_OIDC_FIXTURE_PID" >/dev/null 2>&1 || true
  fi
  if [[ "${KEEP_LOCAL_INTEGRATION:-0}" != "1" ]]; then
    chmod 700 "$BROKER_SIGNING_JWKS_DIR" >/dev/null 2>&1 || true
    rm -f "$BROKER_SIGNING_JWKS_FILE"
    rmdir "$BROKER_SIGNING_JWKS_DIR" >/dev/null 2>&1 || true
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

bun "$ROOT_DIR/scripts/fixtures/hop1-fixture.ts" \
  --port "$BROKER_JWKS_PORT" \
  --issuer "$BROKER_ISSUER" \
  --audience "$AUDIENCE" \
  --token-file "$BROKER_TOKEN_FILE" \
  --signing-jwks-file "$BROKER_SIGNING_JWKS_FILE" \
  >"$WORK_DIR/broker-fixture.log" 2>&1 &
BROKER_FIXTURE_PID=$!

PORT="$GOOGLE_OIDC_PORT" bun "$ROOT_DIR/scripts/fixtures/google-oidc-fixture.ts" \
  >"$WORK_DIR/google-oidc-fixture.log" 2>&1 &
GOOGLE_OIDC_FIXTURE_PID=$!

broker_signing_jwks_ready() {
  [[ -s "$BROKER_SIGNING_JWKS_FILE" ]] && \
    BROKER_SIGNING_JWKS_FILE="$BROKER_SIGNING_JWKS_FILE" bun -e '
      const jwks = await Bun.file(process.env.BROKER_SIGNING_JWKS_FILE).json();
      if (!Array.isArray(jwks.keys) || jwks.keys.length === 0) process.exit(1);
    ' >/dev/null 2>&1
}

for _ in {1..30}; do
  if [[ -s "$TOKEN_FILE" ]] && [[ -s "$BROKER_TOKEN_FILE" ]] && \
    broker_signing_jwks_ready && \
    curl -sS "$FIXTURE_BASE_URL/health" >/dev/null 2>&1 && \
    curl -sS "$BROKER_FIXTURE_BASE_URL/health" >/dev/null 2>&1 && \
    curl -sS "$GOOGLE_OIDC_FIXTURE_BASE_URL/health" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if [[ ! -s "$TOKEN_FILE" ]]; then
  echo "HOP-1 fixture did not produce a token." >&2
  cat "$WORK_DIR/hop1-fixture.log" >&2 || true
  exit 1
fi

if [[ ! -s "$BROKER_TOKEN_FILE" ]]; then
  echo "Broker fixture did not produce a token." >&2
  cat "$WORK_DIR/broker-fixture.log" >&2 || true
  exit 1
fi

if ! broker_signing_jwks_ready; then
  echo "Broker fixture did not produce a complete signing JWKS." >&2
  cat "$WORK_DIR/broker-fixture.log" >&2 || true
  exit 1
fi

# The wrapper runs as UID 10001. Finalize this ephemeral fixture with the same
# read-only access semantics it gets from a projected Kubernetes Secret volume.
chmod 444 "$BROKER_SIGNING_JWKS_FILE"
chmod 555 "$BROKER_SIGNING_JWKS_DIR"

cat >"$ENV_FILE" <<ENV
GATEWAY_PORT=$GATEWAY_PORT
TOKEN_STORE_PORT=$TOKEN_STORE_PORT
GOOGLE_WRAPPER_PORT=$GOOGLE_WRAPPER_PORT
GITHUB_WRAPPER_PORT=$GITHUB_WRAPPER_PORT
AGENTGATEWAY_IMAGE=${LOCAL_AGENTGATEWAY_IMAGE:-ghcr.io/apelogic-ai/mcp-gw-agentgateway:0.4.6}
LOCAL_BROKER_SIGNING_JWKS_DIR=$BROKER_SIGNING_JWKS_DIR
MCP_AUTHORIZATION_ISSUER=$BROKER_ISSUER_INPUT
MCP_RESOURCE_URI=$AUDIENCE
MCP_BROKER_GOOGLE_REDIRECT_URI=$BROKER_ISSUER/google/broker/callback
GOOGLE_OAUTH_AUTHORIZATION_URL=https://accounts.google.com/o/oauth2/v2/auth
GOOGLE_OAUTH_TOKEN_URL=http://host.docker.internal:$GOOGLE_OIDC_PORT/token
GOOGLE_OAUTH_JWKS_URL=http://host.docker.internal:$GOOGLE_OIDC_PORT/jwks
HOP1_PROFILE=local
HOP1_ISSUER=$ISSUER
HOP1_JWKS_URL=$ISSUER/.well-known/jwks.json
HOP1_AUDIENCE=$AUDIENCE
HOP1_ALLOWED_ALGORITHMS=RS256
HOP1_OAUTH_SCOPES=openid email
HOP1_EMAIL_CLAIM=mail
HOP1_SUBJECT_CLAIM=oid
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
GITHUB_SMOKE_HOP1_ISSUERS_JSON=[{"name":"local","issuer":"$ISSUER","jwksUrl":"$ISSUER/.well-known/jwks.json","audiences":["$AUDIENCE"],"allowedAlgorithms":["RS256"],"emailClaim":"mail","subjectClaim":"oid"},{"name":"broker","issuer":"$BROKER_ISSUER","jwksUrl":"http://host.docker.internal:$BROKER_JWKS_PORT/.well-known/jwks.json","audiences":["$AUDIENCE"],"allowedAlgorithms":["RS256"],"emailClaim":"email","subjectClaim":"sub"}]
ENV

EXPECTED_TOOLS=("google_oauth_start" "google_oauth_status")
BROKER_EXPECTED_TOOLS=("google_oauth_start" "google_oauth_status")
if [[ "$INCLUDE_GITHUB" == "1" ]]; then
  COMPOSE_ARGS+=(-f "$ROOT_DIR/deploy/compose/docker-compose.github-mcp.yaml" -f "$LOCAL_GITHUB_COMPOSE_FILE")
  COMPOSE_PROFILES+=(--profile github-mcp)
  COMPOSE_SERVICES+=(github-mcp github-wrapper)
  EXPECTED_TOOLS+=("github_oauth_start" "github_oauth_status")
  BROKER_EXPECTED_TOOLS=(
    "google_google_oauth_start"
    "google_google_oauth_status"
    "github_github_oauth_start"
    "github_github_oauth_status"
  )
fi
printf -v EXPECTED_TOOLS_CSV '%s,' "${BROKER_EXPECTED_TOOLS[@]}"
EXPECTED_TOOLS_CSV="${EXPECTED_TOOLS_CSV%,}"

has_expected_tools() {
  for expected_tool in "${EXPECTED_TOOLS[@]}"; do
    if ! grep -q "$expected_tool" "$RESPONSE_FILE"; then
      return 1
    fi
  done
}

auth_status() {
  local token="${1:-}"
  if [[ -n "$token" ]]; then
    curl -sS -o /dev/null -w "%{http_code}" \
      -X POST "http://127.0.0.1:$GATEWAY_PORT/mcp" \
      -H "authorization: Bearer $token" \
      -H "accept: application/json, text/event-stream" \
      -H "content-type: application/json" \
      -H "mcp-protocol-version: 2025-06-18" \
      --data "$INITIALIZE_PAYLOAD"
    return
  fi

  curl -sS -o /dev/null -w "%{http_code}" \
    -X POST "http://127.0.0.1:$GATEWAY_PORT/mcp" \
    -H "accept: application/json, text/event-stream" \
    -H "content-type: application/json" \
    -H "mcp-protocol-version: 2025-06-18" \
    --data "$INITIALIZE_PAYLOAD"
}

assert_rejected_without_token() {
  [[ "$(auth_status)" == "401" ]]
}

assert_accepted_token() {
  local label="$1"
  local token="$2"
  local status
  status="$(auth_status "$token")"
  if [[ "$status" != "200" ]]; then
    echo "Local integration smoke failed: $label token returned HTTP $status; expected 200." >&2
    return 1
  fi
}

assert_rejected_token() {
  local label="$1"
  local token
  token="$(cat "$TOKEN_FILE.$label")"
  [[ "$(auth_status "$token")" == "401" ]]
}

assert_public_metadata() {
  local status
  status="$(curl -sS -o "$WORK_DIR/resource-metadata.json" -w "%{http_code}" \
    "http://127.0.0.1:$GATEWAY_PORT/.well-known/oauth-protected-resource/mcp")"
  [[ "$status" == "200" ]]
  METADATA_FILE="$WORK_DIR/resource-metadata.json" \
    EXPECTED_RESOURCE="$AUDIENCE" \
    EXPECTED_ISSUER="$BROKER_ISSUER" \
    bun -e '
      const metadata = await Bun.file(process.env.METADATA_FILE).json();
      const expectedIssuer = process.env.EXPECTED_ISSUER;
      if (metadata.resource !== process.env.EXPECTED_RESOURCE) {
        console.error("resource metadata must advertise the exact MCP resource");
        process.exit(1);
      }
      if (JSON.stringify(metadata.authorization_servers) !== JSON.stringify([expectedIssuer])) {
        console.error("authorization_servers must contain only the public broker issuer");
        process.exit(1);
      }
    '
}

assert_fixture_authorization_server() {
  curl -sS "$FIXTURE_BASE_URL/.well-known/oauth-authorization-server" \
    >"$WORK_DIR/authorization-server-metadata.json"
  curl -sS "$FIXTURE_BASE_URL/.well-known/jwks.json" >"$WORK_DIR/jwks.json"
  grep -q '"token_endpoint"' "$WORK_DIR/authorization-server-metadata.json"
  grep -q '"jwks_uri"' "$WORK_DIR/authorization-server-metadata.json"
  grep -q '"keys"' "$WORK_DIR/jwks.json"
}

compose_cmd config >/dev/null
compose_cmd up -d --build "${COMPOSE_SERVICES[@]}"

MIGRATION_LOG="$WORK_DIR/oauth-migrations.log"
MIGRATION_READY=0
for _ in {1..30}; do
  if TOKEN_STORE_DSN="postgres://mcp:mcp@127.0.0.1:$TOKEN_STORE_PORT/mcp" \
    bun "$ROOT_DIR/shared/oauth/migrate.ts" >"$MIGRATION_LOG" 2>&1; then
    MIGRATION_READY=1
    break
  fi
  sleep 1
done

if [[ "$MIGRATION_READY" != "1" ]]; then
  echo "Local integration smoke failed: OAuth migrations did not complete." >&2
  cat "$MIGRATION_LOG" >&2 || true
  exit 1
fi

assert_fixture_authorization_server
TOKEN_RESPONSE="$(curl -sS -X POST "$FIXTURE_BASE_URL/token")"
TOKEN="$(printf '%s' "$TOKEN_RESPONSE" | bun -e 'const body = JSON.parse(await Bun.stdin.text()); process.stdout.write(body.access_token)')"
BROKER_TOKEN="$(cat "$BROKER_TOKEN_FILE")"
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
    BROKER_JOURNEY_ARGS=(
      --broker-base-url "$BROKER_BASE_URL"
      --expected-issuer "$BROKER_ISSUER"
      --expected-tools "$EXPECTED_TOOLS_CSV"
      --gateway-url "http://127.0.0.1:$GATEWAY_PORT/mcp"
      --google-wrapper-url "http://127.0.0.1:$GOOGLE_WRAPPER_PORT/mcp"
      --google-fixture-base-url "$GOOGLE_OIDC_FIXTURE_BASE_URL"
      --resource "$AUDIENCE"
    )
    if [[ "$INCLUDE_GITHUB" == "1" ]]; then
      BROKER_JOURNEY_ARGS+=(--github-wrapper-url "http://127.0.0.1:$GITHUB_WRAPPER_PORT/mcp")
    fi
    bun "$ROOT_DIR/scripts/fixtures/broker-journey-client.ts" "${BROKER_JOURNEY_ARGS[@]}"
    TOKEN_STORE_DSN="postgres://mcp:mcp@127.0.0.1:$TOKEN_STORE_PORT/mcp" \
      bun "$ROOT_DIR/scripts/fixtures/refresh-token-race.ts"
    assert_accepted_token "public broker" "$BROKER_TOKEN"
    assert_rejected_without_token
    assert_rejected_token expired
    assert_rejected_token missing-expiration
    assert_rejected_token wrong-issuer
    assert_rejected_token wrong-audience
    assert_rejected_token invalid-signature
    assert_rejected_token wrong-algorithm
    assert_rejected_token not-before
    assert_public_metadata

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
