FROM node:22-bookworm-slim

# ffmpeg for audio transcoding; ca-certificates for HTTPS to YouTube/GitHub
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY scripts ./scripts

# Pre-download yt-dlp into the image (it self-updates at runtime as well).
RUN node scripts/setup-ytdlp.js && mkdir -p /app/data && chown -R node:node /app
USER node

VOLUME ["/app/data"]
CMD ["node", "src/index.js"]
