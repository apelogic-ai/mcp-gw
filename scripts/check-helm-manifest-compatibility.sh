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
  local values_file="${2:-}"
  local output_file="$3"
  local tree_root="$4"
  local args=(template mcp-gateway "$chart_dir" --kube-version 1.32.0)
  if [[ -n "$values_file" ]]; then
    args+=(--values "$values_file")
  fi
  set +e
  helm "${args[@]}" >"$output_file.stdout" 2>"$output_file.stderr"
  local exit_code=$?
  set -e
  {
    printf 'exit_code=%s\n--- stdout ---\n' "$exit_code"
    sed "s|$tree_root|<repository>|g" "$output_file.stdout"
    printf '%s\n' '--- stderr ---'
    sed "s|$tree_root|<repository>|g" "$output_file.stderr" | LC_ALL=C sort
  } >"$output_file"
}

compare_case() {
  local name="$1"
  local relative_values="${2:-}"
  local base_values=""
  local head_values=""
  if [[ -n "$relative_values" ]]; then
    base_values="$BASE_TREE/$relative_values"
    head_values="$ROOT_DIR/$relative_values"
  fi

  render_case \
    "$BASE_TREE/deploy/k8s/chart" "$base_values" "$TMP_DIR/$name.base.yaml" "$BASE_TREE"
  render_case "$ROOT_DIR/deploy/k8s/chart" "$head_values" "$TMP_DIR/$name.head.yaml" "$ROOT_DIR"
  if ! diff -u --label "$name ($BASE_REF)" --label "$name (HEAD)" \
    "$TMP_DIR/$name.base.yaml" "$TMP_DIR/$name.head.yaml"; then
    echo "Existing Helm manifest contract changed for $name" >&2
    return 1
  fi
}

compare_case default
for values_file in "$ROOT_DIR"/deploy/k8s/examples/values-*.yaml; do
  file_name="$(basename "$values_file")"
  compare_case "${file_name%.yaml}" "deploy/k8s/examples/$file_name"
done

echo "Existing Helm manifests match $BASE_REF for the default chart and every values example."
