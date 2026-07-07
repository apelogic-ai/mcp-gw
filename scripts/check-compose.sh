#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/deploy/compose/docker-compose.yaml"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/deploy/compose/.env.example}"

docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" config >/dev/null

