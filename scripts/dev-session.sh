#!/usr/bin/env bash
set -euo pipefail

AWS_PROFILE="${AWS_PROFILE:-default}"
AWS_REGION="${AWS_REGION:-us-east-1}"
TARGET="${1:-${DEV_INSTANCE_ID:-}}"

if [[ -z "$TARGET" ]]; then
  echo "Usage: scripts/dev-session.sh <instance-id>" >&2
  echo "Or set DEV_INSTANCE_ID." >&2
  exit 1
fi

aws --profile "$AWS_PROFILE" --region "$AWS_REGION" ssm start-session --target "$TARGET"
