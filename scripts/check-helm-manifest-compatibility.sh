#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE_REF="${HELM_COMPAT_BASE_REF:-origin/main}"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/mcp-gw-helm-compat.XXXXXX")"
BASE_TREE="$TMP_DIR/base"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

git -C "$ROOT_DIR" rev-parse --verify "$BASE_REF^{commit}" >/dev/null
mkdir -p "$BASE_TREE"
git -C "$ROOT_DIR" archive "$BASE_REF" deploy/k8s/chart deploy/k8s/examples | tar -x -C "$BASE_TREE"

render_case() {
  local chart_dir="$1"
  local output_file="$2"
  local tree_root="$3"
  shift 3
  local args=(template mcp-gateway "$chart_dir" --kube-version 1.32.0)
  local values_file
  for values_file in "$@"; do
    args+=(--values "$values_file")
  done
  set +e
  helm "${args[@]}" >"$output_file.stdout" 2>"$output_file.stderr"
  local exit_code=$?
  set -e
  {
    printf 'exit_code=%s\n--- stdout ---\n' "$exit_code"
    sed -E "s|$tree_root|<repository>|g; s|(templates/[^:]+):[0-9]+:[0-9]+|\1:<line>:<column>|g" "$output_file.stdout"
    printf '%s\n' '--- stderr ---'
    sed -E "s|$tree_root|<repository>|g; s|(templates/[^:]+):[0-9]+:[0-9]+|\1:<line>:<column>|g" "$output_file.stderr" | LC_ALL=C sort
  } >"$output_file"
}

compare_case() {
  local name="$1"
  shift
  local values_count="$#"
  local base_values=()
  local head_values=()
  local relative_values
  for relative_values in "$@"; do
    base_values+=("$BASE_TREE/$relative_values")
    head_values+=("$ROOT_DIR/$relative_values")
  done

  if [[ "$values_count" -eq 0 ]]; then
    render_case "$BASE_TREE/deploy/k8s/chart" "$TMP_DIR/$name.base.yaml" "$BASE_TREE"
    render_case "$ROOT_DIR/deploy/k8s/chart" "$TMP_DIR/$name.head.yaml" "$ROOT_DIR"
  else
    render_case \
      "$BASE_TREE/deploy/k8s/chart" "$TMP_DIR/$name.base.yaml" "$BASE_TREE" "${base_values[@]}"
    render_case \
      "$ROOT_DIR/deploy/k8s/chart" "$TMP_DIR/$name.head.yaml" "$ROOT_DIR" "${head_values[@]}"
  fi
  if ! diff -u --label "$name ($BASE_REF)" --label "$name (HEAD)" \
    "$TMP_DIR/$name.base.yaml" "$TMP_DIR/$name.head.yaml"; then
    echo "Existing Helm manifest contract changed for $name" >&2
    return 1
  fi
}

compare_case default
for values_file in "$BASE_TREE"/deploy/k8s/examples/values-*.yaml; do
  file_name="$(basename "$values_file")"
  compare_case "${file_name%.yaml}" "deploy/k8s/examples/$file_name"
done
compare_case \
  oauth-broker-with-gateway-api \
  deploy/k8s/examples/values-oauth-broker.example.yaml \
  deploy/k8s/examples/values-gateway-api-broker.example.yaml

echo "Existing Helm manifests match $BASE_REF for the default chart, every pre-existing values example, and documented layered overlays."
