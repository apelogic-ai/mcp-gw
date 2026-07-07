#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHART_DIR="$ROOT_DIR/deploy/k8s/chart"

helm lint "$CHART_DIR"
helm template mcp-gateway "$CHART_DIR" >/dev/null
