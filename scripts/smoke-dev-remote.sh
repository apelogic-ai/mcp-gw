#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INVENTORY="${INVENTORY:-$ROOT_DIR/deploy/infra/ansible/inventory.example.ini}"
ANSIBLE_LOCAL_TEMP="${ANSIBLE_LOCAL_TEMP:-/tmp/ansible-local}"

mkdir -p "$ANSIBLE_LOCAL_TEMP"

ANSIBLE_LOCAL_TEMP="$ANSIBLE_LOCAL_TEMP" \
  ANSIBLE_REMOTE_TEMP="${ANSIBLE_REMOTE_TEMP:-/tmp}" \
  ansible-playbook \
    -i "$INVENTORY" \
    "$ROOT_DIR/deploy/infra/ansible/deploy-compose.yml" \
    --tags smoke
