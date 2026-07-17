#!/usr/bin/env bash
set -euo pipefail
set +x

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TERRAFORM_DIR="$ROOT_DIR/deploy/infra/terraform"
AWS_PROFILE="${AWS_PROFILE:-default}"
AWS_REGION="${AWS_REGION:-us-east-1}"
DEV_ENV_FILE="${DEV_ENV_FILE:-}"
ALLOW_DIRTY_DEPLOY="${ALLOW_DIRTY_DEPLOY:-0}"
APP_DIR="${APP_DIR:-/opt/mcp-gateway}"

if [[ -z "$DEV_ENV_FILE" ]]; then
  echo "DEV_ENV_FILE is required and must point to the local DEV compose env file." >&2
  exit 1
fi

if [[ ! -f "$DEV_ENV_FILE" ]]; then
  echo "DEV_ENV_FILE does not exist: $DEV_ENV_FILE" >&2
  exit 1
fi

if [[ "$ALLOW_DIRTY_DEPLOY" != "1" ]] && [[ -n "$(git -C "$ROOT_DIR" status --short)" ]]; then
  echo "Refusing to deploy a dirty worktree. Commit changes or set ALLOW_DIRTY_DEPLOY=1." >&2
  exit 1
fi

aws --profile "$AWS_PROFILE" --region "$AWS_REGION" sts get-caller-identity >/dev/null
bun run deploy:check

INSTANCE_ID="${DEV_INSTANCE_ID:-$(terraform -chdir="$TERRAFORM_DIR" output -raw mcp_gateway_dev_instance_id)}"
ARTIFACT_BUCKET="${DEV_ARTIFACT_BUCKET:-$(terraform -chdir="$TERRAFORM_DIR" output -raw mcp_gateway_dev_artifact_bucket)}"
GIT_SHA="$(git -C "$ROOT_DIR" rev-parse --short=12 HEAD)"
ARTIFACT_FILE="$(mktemp -t mcp-gw-dev.XXXXXX.tar.gz)"
SCRIPT_FILE="$(mktemp -t mcp-gw-dev-script.XXXXXX.sh)"
PARAMETERS_FILE="$(mktemp -t mcp-gw-ssm-params.XXXXXX.json)"
ARTIFACT_S3_URI="s3://$ARTIFACT_BUCKET/releases/$GIT_SHA.tar.gz"
ENV_S3_URI="s3://$ARTIFACT_BUCKET/env/dev.env"
SCRIPT_S3_URI="s3://$ARTIFACT_BUCKET/scripts/$GIT_SHA.sh"

cleanup() {
  rm -f "$ARTIFACT_FILE" "$SCRIPT_FILE" "$PARAMETERS_FILE"
}
trap cleanup EXIT

git -C "$ROOT_DIR" archive --format=tar.gz -o "$ARTIFACT_FILE" HEAD

aws --profile "$AWS_PROFILE" --region "$AWS_REGION" s3 cp "$ARTIFACT_FILE" "$ARTIFACT_S3_URI" --sse AES256 >/dev/null
aws --profile "$AWS_PROFILE" --region "$AWS_REGION" s3 cp "$DEV_ENV_FILE" "$ENV_S3_URI" --sse AES256 >/dev/null

read -r -d '' REMOTE_SCRIPT <<REMOTE || true
set -euo pipefail
set +x

APP_DIR="$APP_DIR"
AWS_REGION="$AWS_REGION"
ARTIFACT_S3_URI="$ARTIFACT_S3_URI"
ENV_S3_URI="$ENV_S3_URI"

install -d -m 0755 "\$APP_DIR"
rm -rf "\$APP_DIR.next"
install -d -m 0755 "\$APP_DIR.next"

aws s3 cp "\$ARTIFACT_S3_URI" /tmp/mcp-gateway.tar.gz >/dev/null
tar -xzf /tmp/mcp-gateway.tar.gz -C "\$APP_DIR.next"
install -d -m 0755 "\$APP_DIR.next/deploy/compose"
aws s3 cp "\$ENV_S3_URI" "\$APP_DIR.next/deploy/compose/.env" >/dev/null
chmod 0600 "\$APP_DIR.next/deploy/compose/.env"

set -a
. "\$APP_DIR.next/deploy/compose/.env"
set +a
dev_host="\${GOOGLE_OAUTH_REDIRECT_URI#https://}"
dev_host="\${dev_host%%/*}"
compose_args=(
  -f "\$APP_DIR/deploy/compose/docker-compose.yaml"
  -f "\$APP_DIR/deploy/compose/docker-compose.dev.yaml"
)
compose_profiles=()

if [[ "\${ENABLE_GITHUB_MCP:-0}" == "1" ]]; then
  compose_args+=(-f "\$APP_DIR/deploy/compose/docker-compose.github-mcp.yaml")
  compose_profiles+=(--profile github-mcp)
fi

if [[ "\${AGENTGATEWAY_IMAGE:-}" == *.dkr.ecr.*.amazonaws.com/* ]]; then
  ecr_registry="\${AGENTGATEWAY_IMAGE%%/*}"
  aws ecr get-login-password --region "\$AWS_REGION" | docker login --username AWS --password-stdin "\$ecr_registry" >/dev/null
fi

AGENTGATEWAY_MCP_AUTH_YAML="\$(python3 - <<'PY'
import json
import os

def quoted(value):
    return json.dumps(str(value))

issuers_json = os.environ.get("HOP1_ISSUERS_JSON", "").strip()
if issuers_json:
    providers = json.loads(issuers_json)
    print("                providers:")
    for index, provider in enumerate(providers):
        print(f"                  - issuer: {quoted(provider['issuer'])}")
        print("                    audiences:")
        for audience in provider.get("audiences", []):
            print(f"                      - {quoted(audience)}")
        print("                    jwks:")
        print(f"                      url: {quoted(provider['jwksUrl'])}")
        discoverable = provider.get("discoverable", index == 0)
        print(f"                    discoverable: {str(bool(discoverable)).lower()}")
else:
    print(f"                issuer: {quoted(os.environ['HOP1_ISSUER'])}")
    print("                audiences:")
    print(f"                  - {quoted(os.environ['HOP1_AUDIENCE'])}")
    print("                jwks:")
    print(f"                  url: {quoted(os.environ['HOP1_JWKS_URL'])}")
PY
)"

cat > "\$APP_DIR.next/deploy/compose/.agentgateway-dev.yaml" <<YAML
binds:
  - port: 3000
    listeners:
      - routes:
          - matches:
              - path:
                  exact: /mcp
              - path:
                  exact: /.well-known/oauth-protected-resource/mcp
            policies:
              cors:
                allowOrigins: ["*"]
                allowHeaders: [mcp-protocol-version, content-type, authorization]
                exposeHeaders: ["Mcp-Session-Id"]
              mcpAuthentication:
                mode: strict
\${AGENTGATEWAY_MCP_AUTH_YAML}
                resourceMetadata:
                  resource: \${HOP1_AUDIENCE}
                  scopesSupported: [read:all]
                  bearerMethodsSupported: [header]
            backends:
              - mcp:
                  failureMode: failOpen
                  prefixMode: never
                  targets:
                    - name: google
                      policies:
                        backendAuth:
                          passthrough: {}
                      mcp:
                        host: http://google-workspace:8080/mcp
YAML

if [[ "\${ENABLE_GITHUB_MCP:-0}" == "1" ]]; then
  cat >> "\$APP_DIR.next/deploy/compose/.agentgateway-dev.yaml" <<YAML
                    - name: github
                      policies:
                        backendAuth:
                          passthrough: {}
                      mcp:
                        host: http://github-wrapper:8080/mcp
YAML
fi

cat > "\$APP_DIR.next/deploy/compose/.Caddyfile-dev" <<CADDY
\$dev_host {
  encode zstd gzip

  handle / {
    respond "mcp-gateway DEV\n\nMCP: https://\$dev_host/mcp\nOAuth status: https://\$dev_host/oauth/google/status\n" 200
  }

  handle /mcp {
    reverse_proxy agentgateway:3000 {
      header_up X-Forwarded-Proto https
      header_up X-Forwarded-Host {host}
      header_down WWW-Authenticate "Bearer resource_metadata=\"https://\$dev_host/.well-known/oauth-protected-resource/mcp\""
    }
  }

  handle /.well-known/oauth-protected-resource/mcp {
    reverse_proxy agentgateway:3000 {
      header_up X-Forwarded-Proto https
      header_up X-Forwarded-Host {host}
    }
  }

  handle /.well-known/oauth-authorization-server {
    header Content-Type application/json
    respond "{\"issuer\":\"https://accounts.google.com\",\"authorization_endpoint\":\"https://\$dev_host/authorize\",\"token_endpoint\":\"https://\$dev_host/token\",\"jwks_uri\":\"https://www.googleapis.com/oauth2/v3/certs\",\"response_types_supported\":[\"code\"],\"code_challenge_methods_supported\":[\"S256\"],\"scopes_supported\":[\"openid\",\"profile\",\"email\"]}" 200
  }

  handle /.well-known/openid-configuration {
    header Content-Type application/json
    respond "{\"issuer\":\"https://accounts.google.com\",\"authorization_endpoint\":\"https://\$dev_host/authorize\",\"token_endpoint\":\"https://\$dev_host/token\",\"jwks_uri\":\"https://www.googleapis.com/oauth2/v3/certs\",\"response_types_supported\":[\"code\"],\"code_challenge_methods_supported\":[\"S256\"],\"scopes_supported\":[\"openid\",\"profile\",\"email\"]}" 200
  }

  handle /authorize {
    reverse_proxy google-workspace:8080
  }

  handle /token {
    reverse_proxy google-workspace:8080
  }

  handle /oauth/google/* {
    reverse_proxy google-workspace:8080
  }

  handle /oauth/github/* {
    reverse_proxy github-wrapper:8080
  }

  respond 404
}
CADDY

if [[ -d "\$APP_DIR/deploy/compose" ]]; then
  docker compose --env-file "\$APP_DIR/deploy/compose/.env" \\
    -f "\$APP_DIR/deploy/compose/docker-compose.yaml" \\
    -f "\$APP_DIR/deploy/compose/docker-compose.dev.yaml" down --remove-orphans >/dev/null || true
fi

rm -rf "\$APP_DIR.previous"
if [[ -d "\$APP_DIR" ]]; then
  mv "\$APP_DIR" "\$APP_DIR.previous"
fi
mv "\$APP_DIR.next" "\$APP_DIR"

docker compose --env-file "\$APP_DIR/deploy/compose/.env" \\
  "\${compose_args[@]}" \\
  "\${compose_profiles[@]}" config >/dev/null

docker compose --env-file "\$APP_DIR/deploy/compose/.env" \\
  "\${compose_args[@]}" \\
  "\${compose_profiles[@]}" up -d --build

docker compose --env-file "\$APP_DIR/deploy/compose/.env" \\
  "\${compose_args[@]}" \\
  "\${compose_profiles[@]}" ps

status="\$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:\${GATEWAY_PORT:-8080}/mcp" || true)"
if [[ "\$status" == "000" ]]; then
  echo "Gateway did not respond on local port \${GATEWAY_PORT:-8080}." >&2
  exit 1
fi

echo "DEV deploy completed for $GIT_SHA; gateway local /mcp returned HTTP \$status."
REMOTE

printf "%s\n" "$REMOTE_SCRIPT" >"$SCRIPT_FILE"
aws --profile "$AWS_PROFILE" --region "$AWS_REGION" s3 cp "$SCRIPT_FILE" "$SCRIPT_S3_URI" --sse AES256 >/dev/null

REMOTE_COMMAND="aws s3 cp \"$SCRIPT_S3_URI\" /tmp/mcp-gateway-dev-deploy.sh >/dev/null && chmod 0700 /tmp/mcp-gateway-dev-deploy.sh && bash /tmp/mcp-gateway-dev-deploy.sh"

BUN_REMOTE_COMMAND="$REMOTE_COMMAND" bun -e \
  'await Bun.write(process.argv[1], JSON.stringify({ commands: [process.env.BUN_REMOTE_COMMAND] }))' \
  "$PARAMETERS_FILE"

COMMAND_ID="$(
  aws --profile "$AWS_PROFILE" --region "$AWS_REGION" ssm send-command \
    --instance-ids "$INSTANCE_ID" \
    --document-name AWS-RunShellScript \
    --comment "mcp-gateway DEV deploy $GIT_SHA" \
    --parameters "file://$PARAMETERS_FILE" \
    --query Command.CommandId \
    --output text
)"

aws --profile "$AWS_PROFILE" --region "$AWS_REGION" ssm wait command-executed \
  --command-id "$COMMAND_ID" \
  --instance-id "$INSTANCE_ID"

aws --profile "$AWS_PROFILE" --region "$AWS_REGION" ssm get-command-invocation \
  --command-id "$COMMAND_ID" \
  --instance-id "$INSTANCE_ID" \
  --query "{Status:Status,Stdout:StandardOutputContent,Stderr:StandardErrorContent}" \
  --output json
