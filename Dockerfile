FROM oven/bun:1.4.3 AS build
WORKDIR /app
# 运行时使用系统 Chromium，不在构建阶段运行 Puppeteer 的浏览器下载脚本。
ENV PUPPETEER_SKIP_DOWNLOAD=true
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts
COPY src ./src
COPY tsconfig.json ./
RUN bun run build:node

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATABASE_PATH=/app/data/bangumi.sqlite \
    STATS_ENABLED=false \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    PUPPETEER_USER_DATA_DIR=/app/data/browser-profile
WORKDIR /app
# trends 的 browser 模式需要完整浏览器；Chromium 及其运行库较大，不需要时可在部署配置中改用 http。
RUN apt-get update \
    && apt-get install -y --no-install-recommends chromium ca-certificates fonts-liberation \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/dist/node ./dist/node
COPY migrations ./migrations
COPY package.json ./
COPY LICENSE ./
RUN mkdir -p /app/data/browser-profile && chown -R node:node /app/data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:3000/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/node/node.js"]
