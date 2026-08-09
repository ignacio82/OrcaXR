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

# ---- Stage 2: runtime — HTTP slicer server wrapping the patched CLI.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# Runtime libraries for the GUI-linked CLI binary (run under xvfb) + Node.
RUN apt-get update && apt-get install -y \
    curl \
    wget \
    unzip \
    p7zip-full \
    libgtk-3-0 \
    libgl1 \
    libegl1 \
    libglew2.2 \
    libssl-dev \
    libwebkit2gtk-4.1-0 \
    libosmesa6 \
    libgstreamer1.0-0 \
    libgstreamer-plugins-base1.0-0 \
    libsecret-1-0 \
    libmspack0t64 \
    libspnav0 \
    xvfb \
    nodejs \
    npm \
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

# Copy WASM module
COPY wasm/dist /app/wasm/dist

# Copy server code
COPY server/server.js server/security.mjs server/slice_worker.mjs server/preset_key_types.json ./

# The slicer and Node service do not need root. Project/config/output files
# live in /tmp with per-file 0600 permissions.
RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin orcaxr \
    && test -d /home/orcaxr

EXPOSE 3000
ENV PORT=3000
ENV HOST=127.0.0.1
ENV HOME=/home/orcaxr

USER orcaxr

CMD ["node", "server.js"]
