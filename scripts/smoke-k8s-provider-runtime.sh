#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHART_DIR="$ROOT_DIR/deploy/k8s/chart"
VALUES_FILE="$ROOT_DIR/deploy/k8s/examples/values-k8s-provider-runtime-smoke.yaml"
RELEASE_NAME="${K8S_PROVIDER_SMOKE_RELEASE_NAME:-mcp-provider-smoke}"
NAMESPACE="${K8S_PROVIDER_SMOKE_NAMESPACE:-mcp-provider-smoke}"
GOOGLE_IMAGE="${K8S_SMOKE_GOOGLE_IMAGE:-mcp-gw-google-workspace}"
GITHUB_IMAGE="${K8S_SMOKE_GITHUB_IMAGE:-mcp-gw-github-wrapper}"
IMAGE_TAG="${K8S_SMOKE_WRAPPER_TAG:-smoke}"

log_step() {
  printf '\n==> %s\n' "$1"
}

current_github_wrapper_pod() {
  local hash
  hash="$(kubectl get replicaset \
    --namespace "$NAMESPACE" \
    -l app.kubernetes.io/component=github-wrapper \
    -o jsonpath='{range .items[*]}{.spec.replicas}{"\t"}{.metadata.labels.pod-template-hash}{"\n"}{end}' | \
    awk '$1 > 0 { hash = $2 } END { print hash }')"
  kubectl get pod \
    --namespace "$NAMESPACE" \
    -l "app.kubernetes.io/component=github-wrapper,pod-template-hash=$hash" \
    -o jsonpath='{.items[0].metadata.name}'
}

wait_for_sidecar_mcp() {
  local deadline=$((SECONDS + 60))
  local pod="$1"
  while ((SECONDS < deadline)); do
    if kubectl exec "pod/$pod" \
      --namespace "$NAMESPACE" \
      --container github-wrapper -- \
      bun -e 'const response = await fetch("http://127.0.0.1:8082/mcp", { signal: AbortSignal.timeout(2000) }); if (response.status < 100) process.exit(1)' \
      >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  echo "GitHub MCP sidecar endpoint did not become reachable within 60 seconds" >&2
  return 1
}

wait_for_current_github_wrapper_pod() {
  local all_pods current_pod ready
  for _ in {1..120}; do
    if ! current_pod="$(current_github_wrapper_pod 2>/dev/null)" || [[ -z "$current_pod" ]]; then
      sleep 1
      continue
    fi
    if ! all_pods="$(kubectl get pod \
      --namespace "$NAMESPACE" \
      -l app.kubernetes.io/component=github-wrapper \
      -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}')"; then
      sleep 1
      continue
    fi
    if ! ready="$(kubectl get pod "$current_pod" \
      --namespace "$NAMESPACE" \
      -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}')"; then
      sleep 1
      continue
    fi
    if [[ "$ready" == "True" ]] && [[ "$all_pods" == "$current_pod" ]]; then
      printf '%s' "$current_pod"
      return 0
    fi
    sleep 1
  done
  echo "Current GitHub wrapper Pod did not become the sole ready Pod" >&2
  return 1
}

cleanup() {
  helm uninstall "$RELEASE_NAME" --namespace "$NAMESPACE" >/dev/null 2>&1 || true
  kubectl delete namespace "$NAMESPACE" --ignore-not-found --wait=false >/dev/null 2>&1 || true
}

diagnose() {
  local github_wrapper_pod
  github_wrapper_pod="$(current_github_wrapper_pod 2>/dev/null || true)"
  echo "Provider runtime Kubernetes smoke failed; collecting diagnostics" >&2
  kubectl get all --namespace "$NAMESPACE" -o wide >&2 || true
  kubectl get events --namespace "$NAMESPACE" --sort-by=.lastTimestamp >&2 || true
  kubectl logs "deployment/$RELEASE_NAME-google-workspace" --namespace "$NAMESPACE" --tail=200 >&2 || true
  if [[ -n "$github_wrapper_pod" ]]; then
    kubectl logs "pod/$github_wrapper_pod" --namespace "$NAMESPACE" --tail=200 >&2 || true
    kubectl logs "pod/$github_wrapper_pod" --namespace "$NAMESPACE" --container github-mcp --tail=200 >&2 || true
  fi
  kubectl logs "deployment/$RELEASE_NAME-github-mcp" --namespace "$NAMESPACE" --tail=200 >&2 || true
  kubectl logs --namespace "$NAMESPACE" -l app.kubernetes.io/component=oauth-migrations --tail=200 >&2 || true
}

finish() {
  local status=$?
  trap - EXIT
  if [[ "$status" -ne 0 ]]; then
    diagnose
  fi
  cleanup
  exit "$status"
}
trap finish EXIT

kubectl create namespace "$NAMESPACE"
kubectl apply --namespace "$NAMESPACE" -f - <<'YAML'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: postgres
spec:
  replicas: 1
  selector:
    matchLabels:
      app: postgres
  template:
    metadata:
      labels:
        app: postgres
    spec:
      containers:
        - name: postgres
          image: postgres:16-alpine
          env:
            - name: POSTGRES_PASSWORD
              value: fixture-password
          ports:
            - name: postgres
              containerPort: 5432
          readinessProbe:
            exec:
              command: ["pg_isready", "-U", "postgres"]
            periodSeconds: 1
---
apiVersion: v1
kind: Service
metadata:
  name: postgres
spec:
  selector:
    app: postgres
  ports:
    - name: postgres
      port: 5432
      targetPort: postgres
YAML

kubectl rollout status deployment/postgres --namespace "$NAMESPACE" --timeout=120s

kubectl create secret generic provider-runtime \
  --namespace "$NAMESPACE" \
  --from-literal=TOKEN_STORE_DSN="postgresql://postgres:fixture-password@postgres:5432/postgres" \
  --from-literal=GOOGLE_OAUTH_CLIENT_ID=fixture-google-client \
  --from-literal=GOOGLE_OAUTH_CLIENT_SECRET=fixture-google-secret \
  --from-literal=GOOGLE_OAUTH_REDIRECT_URI=https://mcp.example.com/oauth/google/callback \
  --from-literal=GOOGLE_TOKEN_ENCRYPTION_KEY=MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA= \
  --from-literal=GITHUB_OAUTH_CLIENT_ID=fixture-github-client \
  --from-literal=GITHUB_OAUTH_CLIENT_SECRET=fixture-github-secret \
  --from-literal=GITHUB_OAUTH_REDIRECT_URI=https://mcp.example.com/oauth/github/callback \
  --from-literal=GITHUB_TOKEN_ENCRYPTION_KEY=MTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTE=

helm upgrade --install "$RELEASE_NAME" "$CHART_DIR" \
  --namespace "$NAMESPACE" \
  --values "$VALUES_FILE" \
  --set-string "global.imagePullPolicy=Never" \
  --set-string "oauthMigrations.image.repository=$GOOGLE_IMAGE" \
  --set-string "oauthMigrations.image.tag=$IMAGE_TAG" \
  --set-string "googleWorkspace.image.repository=$GOOGLE_IMAGE" \
  --set-string "googleWorkspace.image.tag=$IMAGE_TAG" \
  --set-string "githubWrapper.image.repository=$GITHUB_IMAGE" \
  --set-string "githubWrapper.image.tag=$IMAGE_TAG" \
  --wait \
  --timeout 3m

kubectl rollout status \
  "deployment/$RELEASE_NAME-google-workspace" \
  --namespace "$NAMESPACE" \
  --timeout=120s
kubectl rollout status \
  "deployment/$RELEASE_NAME-github-wrapper" \
  --namespace "$NAMESPACE" \
  --timeout=120s
kubectl rollout status \
  "deployment/$RELEASE_NAME-github-mcp" \
  --namespace "$NAMESPACE" \
  --timeout=120s

log_step "Verify OAuth migrations completed"
MIGRATION_COUNT="$(kubectl exec deployment/postgres --namespace "$NAMESPACE" -- \
  psql -U postgres -tAc 'SELECT count(*) FROM oauth_schema_migrations')"
[[ "$MIGRATION_COUNT" -ge 1 ]]

log_step "Verify provider wrappers run as the non-root user"
GOOGLE_UID="$(kubectl exec "deployment/$RELEASE_NAME-google-workspace" --namespace "$NAMESPACE" -- id -u)"
GITHUB_UID="$(kubectl exec "deployment/$RELEASE_NAME-github-wrapper" --namespace "$NAMESPACE" -- id -u)"
[[ "$GOOGLE_UID" == "10001" ]]
[[ "$GITHUB_UID" == "10001" ]]

log_step "Verify the Google Workspace CLI version"
GWS_VERSION_OUTPUT="$(kubectl exec "deployment/$RELEASE_NAME-google-workspace" \
  --namespace "$NAMESPACE" -- sh -c '"$GWS_BINARY_PATH" --version')"
GWS_VERSION="${GWS_VERSION_OUTPUT%%$'\n'*}"
if [[ "$GWS_VERSION" != "gws 0.22.5" ]]; then
  echo "Unexpected Google Workspace CLI version: expected 'gws 0.22.5', got '$GWS_VERSION'" >&2
  exit 1
fi

log_step "Verify the standalone GitHub MCP security context"
GITHUB_MCP_UID="$(kubectl get deployment "$RELEASE_NAME-github-mcp" \
  --namespace "$NAMESPACE" \
  -o jsonpath='{.spec.template.spec.containers[?(@.name=="github-mcp")].securityContext.runAsUser}')"
GITHUB_MCP_GID="$(kubectl get deployment "$RELEASE_NAME-github-mcp" \
  --namespace "$NAMESPACE" \
  -o jsonpath='{.spec.template.spec.containers[?(@.name=="github-mcp")].securityContext.runAsGroup}')"
[[ "$GITHUB_MCP_UID" == "10001" ]]
[[ "$GITHUB_MCP_GID" == "10001" ]]

kubectl exec -i deployment/postgres --namespace "$NAMESPACE" -- \
  psql -U postgres -v ON_ERROR_STOP=1 <<'SQL'
INSERT INTO oauth_accounts (
  provider,
  hop1_issuer,
  hop1_subject,
  email,
  scopes_granted,
  encrypted_refresh_token,
  created_at,
  updated_at
) VALUES (
  'github',
  'https://identity.example.com',
  'github-mcp-topology-sentinel',
  'sentinel@example.com',
  ARRAY['repo'],
  'fixture-encrypted-credential',
  NOW(),
  NOW()
);
SQL

assert_topology_sentinel() {
  local count=""
  local deadline=$((SECONDS + 60))
  while ((SECONDS < deadline)); do
    if count="$(kubectl exec deployment/postgres --namespace "$NAMESPACE" -- \
      psql -U postgres -tAc \
        "SELECT count(*) FROM oauth_accounts WHERE provider = 'github' AND hop1_subject = 'github-mcp-topology-sentinel'" \
      2>/dev/null)" && [[ "$count" == "1" ]]; then
      return 0
    fi
    sleep 2
  done
  echo "Topology sentinel query did not return 1 within 60 seconds (last result: ${count:-none})" >&2
  return 1
}

upgrade_github_topology() {
  local topology="$1"
  helm upgrade "$RELEASE_NAME" "$CHART_DIR" \
    --namespace "$NAMESPACE" \
    --values "$VALUES_FILE" \
    --set-string "global.imagePullPolicy=Never" \
    --set-string "oauthMigrations.image.repository=$GOOGLE_IMAGE" \
    --set-string "oauthMigrations.image.tag=$IMAGE_TAG" \
    --set-string "googleWorkspace.image.repository=$GOOGLE_IMAGE" \
    --set-string "googleWorkspace.image.tag=$IMAGE_TAG" \
    --set-string "githubWrapper.image.repository=$GITHUB_IMAGE" \
    --set-string "githubWrapper.image.tag=$IMAGE_TAG" \
    --set-string "githubMcp.topology=$topology" \
    --wait \
    --timeout 3m
}

log_step "Switch GitHub MCP topology to sidecar"
upgrade_github_topology sidecar
log_step "Wait for the sidecar GitHub wrapper rollout"
kubectl rollout status \
  "deployment/$RELEASE_NAME-github-wrapper" \
  --namespace "$NAMESPACE" \
  --timeout=120s
log_step "Wait for the sole ready GitHub wrapper Pod"
GITHUB_WRAPPER_POD="$(wait_for_current_github_wrapper_pod)"
log_step "Verify the standalone GitHub MCP Deployment is absent"
if kubectl get deployment "$RELEASE_NAME-github-mcp" --namespace "$NAMESPACE" >/dev/null 2>&1; then
  echo "Standalone GitHub MCP Deployment still exists in sidecar topology" >&2
  exit 1
fi
log_step "Verify the standalone GitHub MCP Service is absent"
if kubectl get service "$RELEASE_NAME-github-mcp" --namespace "$NAMESPACE" >/dev/null 2>&1; then
  echo "Standalone GitHub MCP Service still exists in sidecar topology" >&2
  exit 1
fi
log_step "Verify the sidecar binds only to loopback"
SIDECAR_LISTEN_HOST="$(kubectl get deployment "$RELEASE_NAME-github-wrapper" \
  --namespace "$NAMESPACE" \
  -o jsonpath='{.spec.template.spec.containers[?(@.name=="github-mcp")].args}')"
[[ "$SIDECAR_LISTEN_HOST" == *"--listen-host 127.0.0.1"* ]]
log_step "Wait for the in-Pod GitHub MCP sidecar endpoint"
wait_for_sidecar_mcp "$GITHUB_WRAPPER_POD"
log_step "Verify the sidecar endpoint is isolated from other Pods"
GITHUB_WRAPPER_POD_IP="$(kubectl get pod "$GITHUB_WRAPPER_POD" \
  --namespace "$NAMESPACE" \
  -o jsonpath='{.status.podIP}')"
kubectl exec deployment/postgres --namespace "$NAMESPACE" -- \
  sh -c 'if nc -z -w 2 "$1" 8082; then exit 1; fi' -- "$GITHUB_WRAPPER_POD_IP"
log_step "Verify the topology sentinel after the sidecar switch"
assert_topology_sentinel

log_step "Switch GitHub MCP topology back to separate"
upgrade_github_topology separate
log_step "Wait for the separate GitHub wrapper rollout"
kubectl rollout status \
  "deployment/$RELEASE_NAME-github-wrapper" \
  --namespace "$NAMESPACE" \
  --timeout=120s
log_step "Wait for the sole ready separate GitHub wrapper Pod"
GITHUB_WRAPPER_POD="$(wait_for_current_github_wrapper_pod)"
log_step "Wait for the standalone GitHub MCP rollout"
kubectl rollout status \
  "deployment/$RELEASE_NAME-github-mcp" \
  --namespace "$NAMESPACE" \
  --timeout=120s
log_step "Verify the GitHub MCP sidecar is absent"
[[ "$(kubectl get deployment "$RELEASE_NAME-github-wrapper" \
  --namespace "$NAMESPACE" \
  -o jsonpath='{.spec.template.spec.containers[?(@.name=="github-mcp")].name}')" == "" ]]
log_step "Verify the standalone GitHub MCP Service exists"
kubectl get service "$RELEASE_NAME-github-mcp" --namespace "$NAMESPACE" >/dev/null
log_step "Verify the topology sentinel after the separate switch"
assert_topology_sentinel

echo "Provider runtime Kubernetes smoke passed."
