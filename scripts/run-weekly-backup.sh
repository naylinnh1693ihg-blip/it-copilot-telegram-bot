#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export LOCAL_UID="$(id -u)"
export LOCAL_GID="$(id -g)"
exec docker compose \
  --env-file "$ROOT/.env" \
  --env-file "$ROOT/.env.monitoring" \
  -f "$ROOT/compose.yaml" \
  --profile backup run --rm backup
