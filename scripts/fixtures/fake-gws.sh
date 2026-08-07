#!/bin/sh
set -eu

if [ "${GOOGLE_WORKSPACE_CLI_TOKEN:-}" != "fixture-google-provider-token" ]; then
  printf '%s\n' 'provider credential rejected' >&2
  exit 1
fi

printf '%s\n' '{"files":[{"id":"fixture-document","name":"Fixture document"}]}'
