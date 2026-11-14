#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export LOCAL_UID="$(id -u)"
export LOCAL_GID="$(id -g)"
COMPOSE=(docker compose --env-file "$ROOT/.env" --env-file "$ROOT/.env.monitoring" -f "$ROOT/compose.yaml" --profile backup)

if [[ "$(date +%u)" == "7" ]]; then
  exec "${COMPOSE[@]}" run --rm backup
fi

exec "${COMPOSE[@]}" run --rm backup --prune-only
