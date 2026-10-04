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
npm --prefix server run test:deployment
ORCAXR_SERVER_TOKEN=test-only-token-00000000000000000 \
ORCAXR_ALLOWED_ORIGINS=https://app.example \
  docker compose -f server/docker-compose.yml config --quiet

npm --prefix wasm run test:artifacts
npm --prefix wasm run verify:artifacts
npm --prefix wasm run test:cube
npm --prefix wasm run test:profile
npm --prefix wasm run test:project
npm --prefix wasm run test:painted
npm --prefix wasm run test:painted-prime-tower
npm --prefix wasm run test:fullspectrum
npm --prefix wasm run test:wave

python3 -m unittest scripts/test_maintenance_security.py
npm --prefix web audit --include=dev --audit-level=moderate
npm --prefix server audit --include=dev --audit-level=moderate
npm --prefix wasm audit --include=dev --audit-level=moderate

if [[ "${ORCAXR_BUILD_CONTAINER:-0}" == "1" ]]; then
  ORCAXR_SERVER_TOKEN="${ORCAXR_SERVER_TOKEN:?set ORCAXR_SERVER_TOKEN for the container build}" \
  ORCAXR_ALLOWED_ORIGINS="${ORCAXR_ALLOWED_ORIGINS:?set ORCAXR_ALLOWED_ORIGINS for the container build}" \
    docker compose -f server/docker-compose.yml build
  npm --prefix server run test:deployment:container
  npm --prefix server run test:native:container
fi
