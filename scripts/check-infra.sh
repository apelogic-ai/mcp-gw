#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TERRAFORM_DIR="$ROOT_DIR/deploy/infra/terraform"
ANSIBLE_LOCAL_TEMP="${ANSIBLE_LOCAL_TEMP:-/tmp/ansible-local}"

mkdir -p "$ANSIBLE_LOCAL_TEMP"

terraform -chdir="$TERRAFORM_DIR" fmt -check
terraform -chdir="$TERRAFORM_DIR" init -backend=false
terraform -chdir="$TERRAFORM_DIR" validate

ANSIBLE_LOCAL_TEMP="$ANSIBLE_LOCAL_TEMP" \
  ANSIBLE_REMOTE_TEMP="${ANSIBLE_REMOTE_TEMP:-/tmp}" \
  ansible-playbook \
    -i "$ROOT_DIR/deploy/infra/ansible/inventory.example.ini" \
    "$ROOT_DIR/deploy/infra/ansible/deploy-compose.yml" \
    --syntax-check
