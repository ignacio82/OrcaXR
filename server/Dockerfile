FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# Install dependencies required by Snapmaker OrcaSlicer AppImage (Ubuntu 24.04) and Node.js
RUN apt-get update && apt-get install -y \
    curl \
    wget \
    unzip \
    p7zip-full \
    libfuse2t64 \
    libgtk-3-0 \
    libgl1 \
    libegl1 \
    libglew2.2 \
    libssl-dev \
    libwebkit2gtk-4.1-0 \
    libosmesa6 \
    xvfb \
    nodejs \
    npm \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Official Snapmaker OrcaSlicer — the default slicing engine (SLICER_ENGINE=cli).
# Bump ORCA_VERSION to pick up new Snapmaker releases; keep it pinned (CLI
# flags and profile schemas shift between releases — never track "latest").
ARG ORCA_VERSION=2.3.4
RUN wget -O Snapmaker.zip "https://github.com/Snapmaker/OrcaSlicer/releases/download/v${ORCA_VERSION}/Snapmaker_Orca_Linux_ubuntu_2404_V${ORCA_VERSION}.zip" && \
    unzip Snapmaker.zip && \
    mv Snapmaker_Orca_Linux_AppImage_Ubuntu2404_V${ORCA_VERSION}.AppImage OrcaSlicer.AppImage && \
    chmod +x OrcaSlicer.AppImage && \
    ./OrcaSlicer.AppImage --appimage-extract && \
    rm OrcaSlicer.AppImage Snapmaker.zip

# Make a symlink so `orca-slicer` command is available in PATH
RUN ln -s /app/squashfs-root/AppRun /usr/local/bin/orca-slicer

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
