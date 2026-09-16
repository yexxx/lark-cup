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

FROM nginx:1.28-alpine AS web
COPY --from=build /app/dist /usr/share/nginx/html
COPY deploy/nginx.conf /etc/nginx/nginx.conf
