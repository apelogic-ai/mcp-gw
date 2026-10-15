#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHART_DIR="$ROOT_DIR/deploy/k8s/chart"

helm lint "$CHART_DIR"
helm template mcp-gateway "$CHART_DIR" >/dev/null

JIRA_VALUES="$ROOT_DIR/deploy/k8s/examples/values-jira.example.yaml"
JIRA_FULL_SCOPES='wrappers[0].credential.scopes=["read:jira-user","read:jira-work","read:jira:agent-interface","search:jira:agent-interface","write:jira:agent-interface","offline_access"]'
JIRA_REFUSAL='catalog.preset jira does not work with custom OAuth apps; use jira-read-only'

# The supported read-only preset continues to render unchanged.
helm template mcp-gateway "$CHART_DIR" --values "$JIRA_VALUES" >/dev/null

# The unsupported full preset must fail closed unless the operator explicitly opts in.
set +e
JIRA_OUTPUT="$(helm template mcp-gateway "$CHART_DIR" \
  --values "$JIRA_VALUES" \
  --set 'wrappers[0].catalog.preset=jira' \
  --set-json "$JIRA_FULL_SCOPES" 2>&1)"
JIRA_STATUS=$?
set -e
if [[ "$JIRA_STATUS" -eq 0 ]]; then
  echo "Expected the full Jira preset to require an explicit experimental opt-in" >&2
  exit 1
fi
if [[ "$JIRA_OUTPUT" != *"$JIRA_REFUSAL"* ]]; then
  echo "Full Jira preset refusal did not explain the unsupported custom OAuth path" >&2
  echo "$JIRA_OUTPUT" >&2
  exit 1
fi

# Explicit opt-in preserves the existing full-preset render path.
helm template mcp-gateway "$CHART_DIR" \
  --values "$JIRA_VALUES" \
  --set 'wrappers[0].catalog.preset=jira' \
  --set 'wrappers[0].catalog.experimental=true' \
  --set-json "$JIRA_FULL_SCOPES" >/dev/null
