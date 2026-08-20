#!/bin/sh
set -e

# If TS_AUTHKEY is provided and tailscaled is present, manage Tailscale lifecycle
if [ -n "${TS_AUTHKEY}" ] && [ -x /usr/local/bin/tailscaled ]; then
  echo "[OrcaXR] Starting Tailscale daemon..."
  mkdir -p /var/lib/tailscale /run/tailscale
  /usr/local/bin/tailscaled --state=/var/lib/tailscale/tailscaled.state --socket=/run/tailscale/tailscaled.sock &
  TAILSCALED_PID=$!

  # Wait for tailscaled socket to become available
  for i in $(seq 1 30); do
    if [ -S /run/tailscale/tailscaled.sock ]; then
      break
    fi
    sleep 0.2
  done

  echo "[OrcaXR] Authenticating Tailscale node (${TS_HOSTNAME:-orcaxr})..."
  EXTRA_ARGS=""
  if [ -n "${TS_EXTRA_ARGS}" ]; then
    EXTRA_ARGS="${TS_EXTRA_ARGS}"
  fi

  /usr/local/bin/tailscale --socket=/run/tailscale/tailscaled.sock up \
    --authkey="${TS_AUTHKEY}" \
    --hostname="${TS_HOSTNAME:-orcaxr}" \
    ${EXTRA_ARGS}

  if [ "${TS_SERVE_ENABLED:-true}" = "true" ]; then
    echo "[OrcaXR] Configuring Tailscale Serve on port ${PORT:-3000}..."
    /usr/local/bin/tailscale --socket=/run/tailscale/tailscaled.sock serve --bg "${PORT:-3000}" || {
      echo "[OrcaXR] Warning: tailscale serve failed; check tailscale serve status."
    }
  fi
fi

# Ensure /home/orcaxr/.orcaxr directory exists and has right permissions
mkdir -p /home/orcaxr/.orcaxr
chown -R orcaxr:orcaxr /home/orcaxr

# Drop privileges to user 'orcaxr' if running as root
if [ "$(id -u)" = "0" ]; then
  exec setpriv --reuid=orcaxr --regid=orcaxr --init-groups node /app/server.js "$@"
else
  exec node /app/server.js "$@"
fi
