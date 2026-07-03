FROM node:20-bullseye

# Install dependencies required by OrcaSlicer AppImage (mostly GTK, GL, etc.)
RUN apt-get update && apt-get install -y \
    curl \
    wget \
    p7zip-full \
    libfuse2 \
    libgtk-3-0 \
    libgl1 \
    libegl1 \
    libglew2.1 \
    libssl-dev \
    libwebkit2gtk-4.0-37 \
    libosmesa6 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Download the latest OrcaSlicer AppImage (v2.2.0 as an example, you can bump this)
# We use appimage-extract to extract the payload so we don't need FUSE at runtime
RUN wget -O OrcaSlicer.AppImage "https://github.com/SoftFever/OrcaSlicer/releases/download/v2.2.0/OrcaSlicer_Linux_V2.2.0.AppImage" && \
    chmod +x OrcaSlicer.AppImage && \
    ./OrcaSlicer.AppImage --appimage-extract && \
    rm OrcaSlicer.AppImage

# Make a symlink so `orca-slicer` command is available in PATH
RUN ln -s /app/squashfs-root/AppRun /usr/local/bin/orca-slicer

# Install server dependencies
COPY package*.json ./
RUN npm install

# Copy server code
COPY server.js ./

EXPOSE 3000
ENV PORT=3000

CMD ["npm", "start"]
