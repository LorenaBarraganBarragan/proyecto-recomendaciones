#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "==> Deteniendo aplicación (los volúmenes de datos se conservan)"
docker compose -f docker-compose.app.yml down

echo "==> Deteniendo infraestructura (los volúmenes de datos se conservan)"
docker compose -f docker-compose.yml down
