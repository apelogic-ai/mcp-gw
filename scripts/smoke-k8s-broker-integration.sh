#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHART_DIR="$ROOT_DIR/deploy/k8s/chart"
VALUES_FILE="$ROOT_DIR/deploy/k8s/examples/values-k8s-broker-smoke.yaml"
RELEASE_NAME="mcp-broker-smoke"
NAMESPACE="mcp-broker-smoke"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/mcp-gw-k8s-broker-smoke.XXXXXX")"
AGENTGATEWAY_REPOSITORY="${K8S_BROKER_SMOKE_AGENTGATEWAY_REPOSITORY:?required}"
GOOGLE_REPOSITORY="${K8S_BROKER_SMOKE_GOOGLE_REPOSITORY:?required}"
GITHUB_WRAPPER_REPOSITORY="${K8S_BROKER_SMOKE_GITHUB_WRAPPER_REPOSITORY:?required}"
IMAGE_TAG="${K8S_BROKER_SMOKE_IMAGE_TAG:?required}"
FIXTURE_PID=""

cleanup() {
  if [[ -n "$FIXTURE_PID" ]]; then
    kill "$FIXTURE_PID" >/dev/null 2>&1 || true
    wait "$FIXTURE_PID" >/dev/null 2>&1 || true
  fi
  helm uninstall "$RELEASE_NAME" --namespace "$NAMESPACE" >/dev/null 2>&1 || true
  kubectl delete namespace "$NAMESPACE" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  rm -rf "$WORK_DIR"
}

diagnose() {
  echo "Broker Kubernetes smoke failed; collecting bounded diagnostics" >&2
  kubectl get pods,deployments,services,jobs --namespace "$NAMESPACE" -o wide >&2 || true
  kubectl get events --namespace "$NAMESPACE" --sort-by=.lastTimestamp | tail -n 80 >&2 || true
  kubectl logs "deployment/$RELEASE_NAME-agentgateway" --namespace "$NAMESPACE" --tail=120 >&2 || true
  kubectl logs "deployment/$RELEASE_NAME-google-workspace" --namespace "$NAMESPACE" --tail=120 >&2 || true
  kubectl logs "deployment/$RELEASE_NAME-github-wrapper" --namespace "$NAMESPACE" --tail=120 >&2 || true
  kubectl logs deployment/google-oidc-fixture --namespace "$NAMESPACE" --tail=120 >&2 || true
  kubectl logs broker-smoke-client --namespace "$NAMESPACE" --tail=120 >&2 || true
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

mkdir -p "$WORK_DIR/chart"
chmod 700 "$WORK_DIR"

bun "$ROOT_DIR/scripts/fixtures/hop1-fixture.ts" \
  --port 39092 \
  --issuer https://mcp.example.com/oauth \
  --audience https://mcp.example.com/mcp \
  --token-file "$WORK_DIR/broker.jwt" \
  --signing-jwks-file "$WORK_DIR/signing-jwks.json" \
  >"$WORK_DIR/hop1-fixture.log" 2>&1 &
FIXTURE_PID=$!

for _ in {1..30}; do
  if [[ -s "$WORK_DIR/signing-jwks.json" ]] && [[ -s "$WORK_DIR/broker.jwt.expired" ]]; then
    break
  fi
  sleep 1
done
[[ -s "$WORK_DIR/signing-jwks.json" ]]
[[ -s "$WORK_DIR/broker.jwt.expired" ]]
kill "$FIXTURE_PID" >/dev/null 2>&1 || true
wait "$FIXTURE_PID" >/dev/null 2>&1 || true
FIXTURE_PID=""

kubectl create namespace "$NAMESPACE"
kubectl create configmap google-oidc-fixture \
  --namespace "$NAMESPACE" \
  --from-file="google-oidc-fixture.ts=$ROOT_DIR/scripts/fixtures/google-oidc-fixture.ts"
kubectl apply --namespace "$NAMESPACE" -f - <<YAML
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
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: google-oidc-fixture
spec:
  replicas: 1
  selector:
    matchLabels:
      app: google-oidc-fixture
  template:
    metadata:
      labels:
        app: google-oidc-fixture
    spec:
      containers:
        - name: fixture
          image: $GOOGLE_REPOSITORY:$IMAGE_TAG
          imagePullPolicy: Never
          command: ["bun", "/app/google-oidc-fixture.ts"]
          env:
            - name: PORT
              value: "8080"
          ports:
            - name: http
              containerPort: 8080
          readinessProbe:
            httpGet:
              path: /health
              port: http
            periodSeconds: 1
          volumeMounts:
            - name: fixture-script
              mountPath: /app/google-oidc-fixture.ts
              subPath: google-oidc-fixture.ts
              readOnly: true
      volumes:
        - name: fixture-script
          configMap:
            name: google-oidc-fixture
---
apiVersion: v1
kind: Service
metadata:
  name: google-oidc-fixture
spec:
  selector:
    app: google-oidc-fixture
  ports:
    - name: http
      port: 8080
      targetPort: http
YAML

kubectl rollout status deployment/postgres --namespace "$NAMESPACE" --timeout=180s
kubectl rollout status deployment/google-oidc-fixture --namespace "$NAMESPACE" --timeout=120s

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

kubectl create secret generic broker-signing-keyring \
  --namespace "$NAMESPACE" \
  --from-file="signing-jwks.json=$WORK_DIR/signing-jwks.json"
kubectl create secret generic broker-invalid-tokens \
  --namespace "$NAMESPACE" \
  --from-file="wrong-issuer.jwt=$WORK_DIR/broker.jwt.wrong-issuer" \
  --from-file="wrong-audience.jwt=$WORK_DIR/broker.jwt.wrong-audience" \
  --from-file="invalid-signature.jwt=$WORK_DIR/broker.jwt.invalid-signature" \
  --from-file="expired.jwt=$WORK_DIR/broker.jwt.expired"

helm package "$CHART_DIR" --destination "$WORK_DIR/chart" >/dev/null
CHART_ARCHIVE="$WORK_DIR/chart/mcp-gateway-$(sed -n 's/^version: //p' "$CHART_DIR/Chart.yaml").tgz"
[[ -f "$CHART_ARCHIVE" ]]

helm upgrade --install "$RELEASE_NAME" "$CHART_ARCHIVE" \
  --namespace "$NAMESPACE" \
  --values "$VALUES_FILE" \
  --set-string global.imagePullPolicy=Never \
  --set-string "oauthMigrations.image.repository=$GOOGLE_REPOSITORY" \
  --set-string "oauthMigrations.image.tag=$IMAGE_TAG" \
  --set-string "agentgateway.image.repository=$AGENTGATEWAY_REPOSITORY" \
  --set-string "agentgateway.image.tag=$IMAGE_TAG" \
  --set-string "googleWorkspace.image.repository=$GOOGLE_REPOSITORY" \
  --set-string "googleWorkspace.image.tag=$IMAGE_TAG" \
  --set-string "githubWrapper.image.repository=$GITHUB_WRAPPER_REPOSITORY" \
  --set-string "githubWrapper.image.tag=$IMAGE_TAG" \
  --set-string "googleWorkspace.authorizationBroker.ingressControllerPeer.namespaceSelector.matchLabels.kubernetes\\.io/metadata\\.name=$NAMESPACE" \
  --set-string "googleWorkspace.authorizationBroker.ingressControllerPeer.podSelector.matchLabels.app\\.kubernetes\\.io/component=broker-smoke-client" \
  --wait \
  --timeout 5m

# The pinned AgentGateway snapshots remote JWKS when it loads configuration.
# Stage that load after the broker is Ready so this fanout regression isolates
# the published-key contract under test instead of depending on pod start order.
kubectl rollout status "deployment/$RELEASE_NAME-google-workspace" \
  --namespace "$NAMESPACE" \
  --timeout=120s
helm upgrade "$RELEASE_NAME" "$CHART_ARCHIVE" \
  --namespace "$NAMESPACE" \
  --reuse-values \
  --set-string "agentgateway.podAnnotations.mcp-gateway\.apelogic\.io/broker-ready=verified" \
  --wait \
  --timeout 5m

kubectl create configmap broker-journey-client \
  --namespace "$NAMESPACE" \
  --from-file="broker-journey-client.ts=$ROOT_DIR/scripts/fixtures/broker-journey-client.ts"

kubectl apply --namespace "$NAMESPACE" -f - <<YAML
apiVersion: v1
kind: Pod
metadata:
  name: broker-smoke-client
  labels:
    app.kubernetes.io/component: broker-smoke-client
spec:
  restartPolicy: Never
  securityContext:
    runAsNonRoot: true
    runAsUser: 10001
    runAsGroup: 10001
  initContainers:
    - name: wait-for-agentgateway
      image: $GOOGLE_REPOSITORY:$IMAGE_TAG
      imagePullPolicy: Never
      command: ["bun", "-e"]
      args:
        - |
          const deadline = Date.now() + 30_000;
          let lastError;
          while (Date.now() < deadline) {
            try {
              const response = await fetch(process.env.GATEWAY_URL, {
                method: "GET",
                redirect: "manual",
                signal: AbortSignal.timeout(1_000),
              });
              await response.body?.cancel();
              process.exit(0);
            } catch (error) {
              lastError = error;
              await Bun.sleep(250);
            }
          }
          console.error("AgentGateway MCP endpoint did not become reachable", lastError);
          process.exit(1);
      env:
        - name: GATEWAY_URL
          value: http://$RELEASE_NAME-agentgateway:8080/mcp
  containers:
    - name: client
      image: $GOOGLE_REPOSITORY:$IMAGE_TAG
      imagePullPolicy: Never
      command: ["bun", "/app/broker-journey-client.ts"]
      args:
        - --broker-base-url
        - http://$RELEASE_NAME-authorization-broker:8080/oauth
        - --expected-data-tools
        - google_drive_files_list,get_file_contents
        - --expected-issuer
        - https://mcp.example.com/oauth
        - --expected-tools
        - google_oauth_start,google_oauth_status,github_oauth_start,github_oauth_status
        - --gateway-url
        - http://$RELEASE_NAME-agentgateway:8080/mcp
        - --google-fixture-base-url
        - http://google-oidc-fixture:8080
        - --invalid-token-directory
        - /var/run/secrets/mcp-gateway/invalid-tokens
        - --resource
        - https://mcp.example.com/mcp
        - --scope
        - mcp
      volumeMounts:
        - name: client-script
          mountPath: /app/broker-journey-client.ts
          subPath: broker-journey-client.ts
          readOnly: true
        - name: invalid-tokens
          mountPath: /var/run/secrets/mcp-gateway/invalid-tokens
          readOnly: true
  volumes:
    - name: client-script
      configMap:
        name: broker-journey-client
    - name: invalid-tokens
      secret:
        secretName: broker-invalid-tokens
YAML

client_phase=""
for _ in {1..180}; do
  client_phase="$(kubectl get pod broker-smoke-client --namespace "$NAMESPACE" \
    -o jsonpath='{.status.phase}')"
  case "$client_phase" in
    Succeeded) break ;;
    Failed) exit 1 ;;
  esac
  sleep 1
done
[[ "$client_phase" == "Succeeded" ]]
kubectl logs broker-smoke-client --namespace "$NAMESPACE"

for component in agentgateway google-workspace github-wrapper; do
  actual_image="$(kubectl get deployment "$RELEASE_NAME-$component" --namespace "$NAMESPACE" \
    -o jsonpath='{.spec.template.spec.containers[0].image}')"
  case "$component" in
    agentgateway) expected_image="$AGENTGATEWAY_REPOSITORY:$IMAGE_TAG" ;;
    google-workspace) expected_image="$GOOGLE_REPOSITORY:$IMAGE_TAG" ;;
    github-wrapper) expected_image="$GITHUB_WRAPPER_REPOSITORY:$IMAGE_TAG" ;;
  esac
  [[ "$actual_image" == "$expected_image" ]]
done

echo "Broker Kubernetes release-image smoke passed."
