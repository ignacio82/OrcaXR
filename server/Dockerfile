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
RUN git clone --depth 1 --branch "v${ORCA_VERSION}" \
    https://github.com/Snapmaker/OrcaSlicer.git /orca

WORKDIR /orca

# Dependencies first — they are patch-independent, so iterating on OrcaXR
# patches only rebuilds the (much cheaper) slicer stage below.
RUN ./build_linux.sh -dr

COPY patches/ /orca-patches/
RUN git apply --verbose /orca-patches/*.patch && ./build_linux.sh -sr

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

# Install server dependencies
COPY package*.json ./
RUN npm install

# Copy WASM module
COPY wasm-dist /app/wasm/dist

# Copy server code
COPY server.js slice_worker.mjs preset_key_types.json ./

EXPOSE 3000
ENV PORT=3000

CMD ["node", "server.js"]
