# ---- Stage 1: build the Snapmaker Orca CLI from source, with OrcaXR patches.
#
# The released 2.3.3/2.3.4 AppImages segfault on every multi-filament
# project-3MF `--slice` run: PartPlate::get_extruders_under_cli →
# expand_plate_extruders → wxGetApp().preset_bundle (null in the headless
# CLI). FullSpectrum/mixed-filament slicing therefore REQUIRES a patched
# from-source build — see patches/0001-cli-safe-expand-plate-extruders.patch.
FROM ubuntu:24.04 AS orca-build

ENV DEBIAN_FRONTEND=noninteractive

# Superset of scripts/linux.d/debian REQUIRED_DEV_PACKAGES for v2.3.4.
# libwebkit2gtk-4.1-dev is load-bearing: without it wxWidgets configures
# WITHOUT webview and the slicer link fails on libwx_gtk3u_webview-3.1.a.
RUN apt-get update && apt-get install -y \
    autoconf build-essential ca-certificates cmake eglexternalplatform-dev \
    extra-cmake-modules file gettext git libcurl4-openssl-dev libdbus-1-dev \
    libglew-dev libgstreamerd-3-dev libgtk-3-dev libmspack-dev libsecret-1-dev \
    libspnav-dev libssl-dev libtool libudev-dev libwebkit2gtk-4.1-dev \
    ninja-build texinfo wget \
    && rm -rf /var/lib/apt/lists/*

# Bump ORCA_VERSION to pick up new Snapmaker releases; keep it pinned (CLI
# flags and profile schemas shift between releases — never track "latest").
ARG ORCA_VERSION=2.3.4
ARG ORCA_COMMIT=9fd12ffb2b1b80c9fb4c14564754d2ec1573a626
RUN git clone --filter=blob:none --no-checkout \
    https://github.com/Snapmaker/OrcaSlicer.git /orca \
    && git -C /orca fetch --depth 1 origin "${ORCA_COMMIT}" \
    && git -C /orca checkout --detach "${ORCA_COMMIT}" \
    && test "$(git -C /orca rev-parse HEAD)" = "${ORCA_COMMIT}"

WORKDIR /orca

# Dependencies first — they are patch-independent, so iterating on OrcaXR
# patches only rebuilds the (much cheaper) slicer stage below.
RUN ./build_linux.sh -dr

COPY server/patches/ /orca-patches/
RUN git apply --verbose /orca-patches/*.patch && ./build_linux.sh -sr

# Record what this engine actually is, so the server can prove it to a client
# instead of asking to be trusted. The patch digests are part of the identity:
# they are the exact difference between this binary and stock upstream, and a
# client is entitled to see them rather than be told the engine is "official".
RUN set -eu; \
    patches=$(for f in /orca-patches/*.patch; do \
        printf '{"name":"%s","sha256":"%s"},' "$(basename "$f")" "$(sha256sum "$f" | cut -d' ' -f1)"; \
      done | sed 's/,$//'); \
    printf '{"schemaVersion":1,"engine":{"name":"snapmaker-orca","version":"%s","commit":"%s"},"patches":[%s]}' \
      "${ORCA_VERSION}" "${ORCA_COMMIT}" "${patches}" \
      > /orca/build/package/engine-provenance.json

# ---- Stage 2: web-builder — build the production Web UI from source
FROM node:22-slim AS web-builder

WORKDIR /build/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# ---- Stage 3: tailscale — extract official Tailscale daemon and client binaries
FROM tailscale/tailscale:v1.78.1 AS tailscale

# ---- Stage 4: runtime — all-in-one OrcaXR container (Web UI + Slicer Server + optional Tailscale)
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# Runtime libraries for the GUI-linked CLI binary (run under xvfb), Node, and Tailscale networking.
RUN apt-get update && apt-get install -y \
    ca-certificates \
    curl \
    iptables \
    iproute2 \
    libegl1 \
    libgl1 \
    libglew2.2 \
    libgstreamer-plugins-base1.0-0 \
    libgstreamer1.0-0 \
    libgtk-3-0 \
    libmspack0t64 \
    libosmesa6 \
    libsecret-1-0 \
    libspnav0 \
    libssl-dev \
    libwebkit2gtk-4.1-0 \
    nodejs \
    npm \
    p7zip-full \
    unzip \
    util-linux \
    wget \
    xvfb \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# The assembled app tree (bin/ + resources/) from the source build.
COPY --from=orca-build /orca/build/package /app/orca

# Same entry point name/contract as the old AppImage-based image.
RUN printf '#!/bin/sh\nexport LD_LIBRARY_PATH="/app/orca/bin:${LD_LIBRARY_PATH}"\nexec /app/orca/bin/snapmaker-orca "$@"\n' \
        > /usr/local/bin/orca-slicer && chmod +x /usr/local/bin/orca-slicer

# Complete the provenance manifest with a digest of the binary that will run.
# It is taken here, in the runtime image, from the file the server executes.
RUN set -eu; \
    digest=$(sha256sum /app/orca/bin/snapmaker-orca | cut -d' ' -f1); \
    node -e 'const fs=require("fs");const p="/app/orca/engine-provenance.json";\
      const m=JSON.parse(fs.readFileSync(p,"utf8"));\
      m.binary={path:"/app/orca/bin/snapmaker-orca",sha256:process.argv[1]};\
      fs.writeFileSync(p,JSON.stringify(m));' "$digest"

# Install server dependencies
COPY server/package*.json ./
RUN npm ci --omit=dev

# The WASM engine, with the provenance manifest beside it.
COPY wasm/dist /app/wasm-dist
COPY wasm/artifact-provenance.json /app/wasm-dist/artifact-provenance.json

# Copy compiled Web UI static assets
COPY --from=web-builder /build/web/dist /app/public
COPY --from=web-builder /build/web/src/slicer/pinnedEngineProvenance.ts /tmp/pinnedEngineProvenance.ts

# Build-time coherence check: verify the compiled front-end's engine pin
# matches the image's engine provenance.
RUN node -e '
  const fs = require("fs");
  const prov = JSON.parse(fs.readFileSync("/app/orca/engine-provenance.json", "utf8"));
  const pinnedTs = fs.readFileSync("/tmp/pinnedEngineProvenance.ts", "utf8");
  if (!pinnedTs.includes(prov.engine.commit)) {
    console.error("COHERENCE FAILURE: Front-end pinned commit does not match server engine commit.");
    process.exit(1);
  }
  for (const patch of prov.patches) {
    if (!pinnedTs.includes(patch.sha256)) {
      console.error("COHERENCE FAILURE: Front-end does not pin patch " + patch.name + " (" + patch.sha256 + ")");
      process.exit(1);
    }
  }
  console.log("Coherence check passed: front-end pins match engine provenance.");
' && rm -f /tmp/pinnedEngineProvenance.ts

# Copy Tailscale binaries
COPY --from=tailscale /usr/local/bin/tailscale /usr/local/bin/tailscale
COPY --from=tailscale /usr/local/bin/tailscaled /usr/local/bin/tailscaled

# Copy server code and entrypoint
COPY server/server.js server/security.mjs server/slice_worker.mjs server/preset_key_types.json ./
COPY server/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# User and state directories
RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin orcaxr \
    && mkdir -p /var/lib/tailscale /run/tailscale /home/orcaxr/.orcaxr \
    && chown -R orcaxr:orcaxr /home/orcaxr /var/lib/tailscale /run/tailscale

EXPOSE 3000
ENV PORT=3000
ENV HOST=127.0.0.1
ENV ORCAXR_TRUST=same-origin
ENV HOME=/home/orcaxr

ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["server.js"]
