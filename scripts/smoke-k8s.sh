#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHART_DIR="$ROOT_DIR/deploy/k8s/chart"
VALUES_FILE="$ROOT_DIR/deploy/k8s/examples/values-k8s-smoke.yaml"
RELEASE_NAME="${K8S_SMOKE_RELEASE_NAME:-mcp-gateway-smoke}"
NAMESPACE="${K8S_SMOKE_NAMESPACE:-mcp-gateway-smoke}"
CLUSTER_NAME="${K8S_SMOKE_CLUSTER_NAME:-mcp-gateway-smoke}"
CREATED_CLUSTER=false

cleanup() {
  helm uninstall "$RELEASE_NAME" --namespace "$NAMESPACE" >/dev/null 2>&1 || true
  if [[ "$CREATED_CLUSTER" == "true" ]]; then
    kind delete cluster --name "$CLUSTER_NAME" >/dev/null 2>&1 || true
  fi
}

diagnose() {
  echo "Kubernetes smoke failed; collecting namespace diagnostics" >&2
  kubectl get all --namespace "$NAMESPACE" -o wide >&2 || true
  kubectl describe deployment "$RELEASE_NAME-agentgateway" --namespace "$NAMESPACE" >&2 || true
  kubectl get configmap "$RELEASE_NAME-agentgateway-config" --namespace "$NAMESPACE" -o yaml >&2 || true
  kubectl logs "deployment/$RELEASE_NAME-agentgateway" \
    --namespace "$NAMESPACE" \
    --all-containers \
    --tail=200 >&2 || true
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

if [[ "${K8S_SMOKE_CREATE_CLUSTER:-false}" == "true" ]]; then
  kind create cluster --name "$CLUSTER_NAME" --wait 120s
  CREATED_CLUSTER=true
fi

install_chart() {
  helm upgrade --install "$RELEASE_NAME" "$CHART_DIR" \
    --namespace "$NAMESPACE" \
    --create-namespace \
    --values "$VALUES_FILE" \
    "$@" \
    --wait \
    --timeout 3m
}

if [[ -n "${K8S_SMOKE_AGENTGATEWAY_REPOSITORY:-}" ]]; then
  : "${K8S_SMOKE_AGENTGATEWAY_TAG:?K8S_SMOKE_AGENTGATEWAY_TAG is required when overriding the repository}"
  install_chart \
    --set-string "agentgateway.image.repository=$K8S_SMOKE_AGENTGATEWAY_REPOSITORY" \
    --set-string "agentgateway.image.tag=$K8S_SMOKE_AGENTGATEWAY_TAG" \
    --set-string "global.imagePullPolicy=Never"
else
  install_chart
fi

kubectl rollout status \
  "deployment/$RELEASE_NAME-agentgateway" \
  --namespace "$NAMESPACE" \
  --timeout=120s

METADATA_OUTPUT="$(kubectl run mcp-metadata-probe \
  --namespace "$NAMESPACE" \
  --image=curlimages/curl:8.16.0 \
  --restart=Never \
  --rm \
  --attach \
  --quiet \
  --command -- curl -sS -o /dev/null -w 'METADATA_STATUS:%{http_code}\n' \
  "http://$RELEASE_NAME-agentgateway.$NAMESPACE.svc.cluster.local:8080/.well-known/oauth-protected-resource/mcp")"
METADATA_STATUS="$(printf '%s\n' "$METADATA_OUTPUT" | \
  sed -n 's/.*METADATA_STATUS:\([0-9][0-9][0-9]\).*/\1/p' | tail -n 1)"

[[ "$METADATA_STATUS" == "200" ]]

# A syntactically valid JWT selects the unavailable issuer. Signature
# verification must fail closed without changing Deployment readiness.
UNAVAILABLE_ISSUER_TOKEN="eyJhbGciOiJSUzI1NiIsImtpZCI6InNtb2tlIn0.eyJpc3MiOiJodHRwczovL3VuYXZhaWxhYmxlLmV4YW1wbGUuY29tIiwiYXVkIjoiaHR0cHM6Ly9tY3AuZXhhbXBsZS5jb20vbWNwIiwic3ViIjoic21va2UiLCJlbWFpbCI6InNtb2tlQGV4YW1wbGUuY29tIiwiZXhwIjo0MTAyNDQ0ODAwfQ.c2lnbmF0dXJl"
UNAVAILABLE_ISSUER_OUTPUT="$(kubectl run mcp-auth-probe \
  --namespace "$NAMESPACE" \
  --image=curlimages/curl:8.16.0 \
  --restart=Never \
  --rm \
  --attach \
  --quiet \
  --command -- curl -sS -o /dev/null -w 'MCP_STATUS:%{http_code}\n' \
  -X POST \
  -H "authorization: Bearer $UNAVAILABLE_ISSUER_TOKEN" \
  -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"k8s-smoke","version":"1.0.0"}}}' \
  "http://$RELEASE_NAME-agentgateway.$NAMESPACE.svc.cluster.local:8080/mcp")"
UNAVAILABLE_ISSUER_STATUS="$(printf '%s\n' "$UNAVAILABLE_ISSUER_OUTPUT" | \
  sed -n 's/.*MCP_STATUS:\([0-9][0-9][0-9]\).*/\1/p' | tail -n 1)"

[[ "$UNAVAILABLE_ISSUER_STATUS" == "401" ]]
kubectl get deployment "$RELEASE_NAME-agentgateway" --namespace "$NAMESPACE" \
  -o jsonpath='{.status.readyReplicas}' | grep -Eq '^[1-9][0-9]*$'
