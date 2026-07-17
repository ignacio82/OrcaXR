#!/usr/bin/env bash
# Clean-clone parity gate. CI splits these stages into parallel jobs; this
# wrapper deliberately keeps a single local entry point and stops at the first
# failed contract.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

npm --prefix web ci
npm --prefix server ci
npm --prefix wasm ci

npm --prefix web run quality

npm --prefix server test
npm --prefix server run test:integration
ORCAXR_SERVER_TOKEN=0123456789abcdef0123456789abcdef \
ORCAXR_ALLOWED_ORIGINS=https://app.example \
  docker compose -f server/docker-compose.yml config --quiet

npm --prefix wasm run verify:artifacts
npm --prefix wasm run test:cube
npm --prefix wasm run test:profile
npm --prefix wasm run test:project
npm --prefix wasm run test:painted
npm --prefix wasm run test:painted-prime-tower
npm --prefix wasm run test:fullspectrum

npm --prefix web audit --omit=dev --audit-level=high
npm --prefix server audit --omit=dev --audit-level=high
npm --prefix wasm audit --omit=dev --audit-level=high

if [[ "${ORCAXR_BUILD_CONTAINER:-0}" == "1" ]]; then
  ORCAXR_SERVER_TOKEN="${ORCAXR_SERVER_TOKEN:?set ORCAXR_SERVER_TOKEN for the container build}" \
  ORCAXR_ALLOWED_ORIGINS="${ORCAXR_ALLOWED_ORIGINS:?set ORCAXR_ALLOWED_ORIGINS for the container build}" \
    docker compose -f server/docker-compose.yml build
fi
