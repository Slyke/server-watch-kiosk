# syntax=docker/dockerfile:1
FROM node:24.21.0-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS build
ARG BUILD_HASH=unknown
ENV BUILD_HASH=${BUILD_HASH}
COPY tsconfig.json tsconfig.server.json vite.config.ts svelte.config.js index.html ./
COPY src ./src
COPY public ./public
COPY scripts/write-build-info.mjs ./scripts/write-build-info.mjs
RUN npm run build

FROM node:24.21.0-bookworm-slim AS production-dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:24.21.0-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# ping is optional at runtime; NET_RAW is deliberately not granted by Compose.
RUN apt-get update && apt-get install -y --no-install-recommends iputils-ping ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/build-info.json ./build-info.json
COPY package.json config.json5 ./
COPY checks ./checks
USER node
EXPOSE 8098
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:8098/livez').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "dist/server/main.js"]
