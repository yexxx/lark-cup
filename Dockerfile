FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:24-bookworm-slim AS api
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app/package*.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/server ./server
COPY --from=build --chown=node:node /app/public ./public
RUN mkdir -p /app/data/uploads && chown -R node:node /app/data
USER node
EXPOSE 3001 3002
CMD ["node", "--import", "tsx", "server/index.ts"]

FROM node:24-bookworm-slim AS renderer
WORKDIR /app
ENV NODE_ENV=production PLAYWRIGHT_BROWSERS_PATH=/ms-playwright RENDERER_HOST=0.0.0.0
COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
RUN npx playwright install --with-deps chromium && apt-get update && apt-get install -y --no-install-recommends fonts-noto-cjk && rm -rf /var/lib/apt/lists/* && chmod -R a+rX /ms-playwright
COPY --from=build --chown=node:node /app/server/cover-renderer.ts /app/server/cover-render-worker.ts /app/server/preview-policy.ts ./server/
USER node
EXPOSE 3003
CMD ["node", "--import", "tsx", "server/cover-renderer.ts"]

FROM nginx:1.28-alpine AS web
COPY --from=build /app/dist /usr/share/nginx/html
COPY deploy/nginx.conf /etc/nginx/nginx.conf
