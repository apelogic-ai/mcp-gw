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

cleanup() {
  helm uninstall "$RELEASE_NAME" --namespace "$NAMESPACE" >/dev/null 2>&1 || true
  kubectl delete namespace "$NAMESPACE" --ignore-not-found --wait=false >/dev/null 2>&1 || true
}

diagnose() {
  echo "Provider runtime Kubernetes smoke failed; collecting diagnostics" >&2
  kubectl get all --namespace "$NAMESPACE" -o wide >&2 || true
  kubectl get events --namespace "$NAMESPACE" --sort-by=.lastTimestamp >&2 || true
  kubectl logs "deployment/$RELEASE_NAME-google-workspace" --namespace "$NAMESPACE" --tail=200 >&2 || true
  kubectl logs "deployment/$RELEASE_NAME-github-wrapper" --namespace "$NAMESPACE" --tail=200 >&2 || true
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

MIGRATION_COUNT="$(kubectl exec deployment/postgres --namespace "$NAMESPACE" -- \
  psql -U postgres -tAc 'SELECT count(*) FROM oauth_schema_migrations')"
[[ "$MIGRATION_COUNT" -ge 1 ]]

GOOGLE_UID="$(kubectl exec "deployment/$RELEASE_NAME-google-workspace" --namespace "$NAMESPACE" -- id -u)"
GITHUB_UID="$(kubectl exec "deployment/$RELEASE_NAME-github-wrapper" --namespace "$NAMESPACE" -- id -u)"
[[ "$GOOGLE_UID" == "10001" ]]
[[ "$GITHUB_UID" == "10001" ]]

echo "Provider runtime Kubernetes smoke passed."
