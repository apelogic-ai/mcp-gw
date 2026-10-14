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

is_explicit_legacy_default_only() {
  local diff_file="$1"
  local names=0
  local values=0
  local line
  local line_number=0

  while IFS= read -r line; do
    line_number=$((line_number + 1))
    if [[ "$line_number" -eq 1 && "$line" == '--- '* ]]; then
      continue
    fi
    if [[ "$line_number" -eq 2 && "$line" == '+++ '* ]]; then
      continue
    fi
    case "$line" in
      '@@ '*|' '*) ;;
      '+            - name: MCP_GW_ALLOW_LEGACY_UNSCOPED_TASK_TOKENS')
        names=$((names + 1))
        ;;
      '+              value: "false"')
        values=$((values + 1))
        ;;
      *)
        return 1
        ;;
    esac
  done <"$diff_file"

  [[ "$names" -gt 0 && "$names" -eq "$values" ]]
}

is_jira_read_only_rest_only() {
  local diff_file="$1"
  local old_catalog=0 new_catalog=0 filter=0 scopes=0 old_checksum=0 new_checksum=0 line
  while IFS= read -r line; do
    case "$line" in
      '--- '*|'+++ '*|'@@ '*|' '*) ;;
      '-    catalogPath: /app/servers/generic-wrapper/catalog/jira/decisions.yaml') old_catalog=$((old_catalog + 1)) ;;
      '+    catalogPath: /app/servers/generic-wrapper/catalog/jira/read-only.yaml') new_catalog=$((new_catalog + 1)) ;;
      '-    catalogFilter:'|'-      actionClasses: [read]') filter=$((filter + 1)) ;;
      '-      - read:jira:agent-interface'|'-      - search:jira:agent-interface') scopes=$((scopes + 1)) ;;
      '-        checksum/generic-wrapper-config: '*)
        [[ "${line##*: }" =~ ^[0-9a-f]{64}$ ]] || return 1
        old_checksum=$((old_checksum + 1))
        ;;
      '+        checksum/generic-wrapper-config: '*)
        [[ "${line##*: }" =~ ^[0-9a-f]{64}$ ]] || return 1
        new_checksum=$((new_checksum + 1))
        ;;
      *) return 1 ;;
    esac
  done <"$diff_file"
  [[ "$old_catalog" -eq 1 && "$new_catalog" -eq 1 && "$filter" -eq 2 && "$scopes" -eq 2 && "$old_checksum" -eq 1 && "$new_checksum" -eq 1 ]]
}

normalize_required_jira_read_work_scope() {
  local base_values="$BASE_TREE/deploy/k8s/examples/values-jira.example.yaml"
  local head_values="$ROOT_DIR/deploy/k8s/examples/values-jira.example.yaml"
  local exact_scope='        - read:jira-work'

  if grep -Fqx "$exact_scope" "$base_values"; then
    return
  fi
  if ! grep -Fqx "$exact_scope" "$head_values"; then
    return
  fi

  # Normalize only this newly required scope in the archived base. The rendered
  # comparison still rejects every unrelated manifest change.
  perl -0pi -e 's/(        - read:jira-user\n)/$1        - read:jira-work\n/' "$base_values"
  if ! grep -Fqx "$exact_scope" "$base_values"; then
    echo "Failed to normalize the required Jira read:jira-work scope" >&2
    return 1
  fi
  echo "Normalized the required Jira read:jira-work scope before Helm compatibility comparison"
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
  local diff_file="$TMP_DIR/$name.diff"
  if ! diff -u --label "$name ($BASE_REF)" --label "$name (HEAD)" \
    "$TMP_DIR/$name.base.yaml" "$TMP_DIR/$name.head.yaml" >"$diff_file"; then
    cat "$diff_file"
    if is_explicit_legacy_default_only "$diff_file"; then
      echo "Accepted explicit false Task-token compatibility setting for $name"
    elif [[ "$name" == "values-jira.example" ]] && is_jira_read_only_rest_only "$diff_file"; then
      echo "Accepted the exact Jira read-only REST preset manifest change for $name"
    else
      echo "Existing Helm manifest contract changed for $name" >&2
      return 1
    fi
  fi
}

normalize_required_jira_read_work_scope
compare_case default
for values_file in "$BASE_TREE"/deploy/k8s/examples/values-*.yaml; do
  file_name="$(basename "$values_file")"
  compare_case "${file_name%.yaml}" "deploy/k8s/examples/$file_name"
done
compare_case \
  oauth-broker-with-gateway-api \
  deploy/k8s/examples/values-oauth-broker.example.yaml \
  deploy/k8s/examples/values-gateway-api-broker.example.yaml

echo "Existing Helm manifests satisfy the compatibility contract against $BASE_REF for the default chart, every pre-existing values example, and documented layered overlays."
