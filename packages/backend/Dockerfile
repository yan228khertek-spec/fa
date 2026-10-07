# Приёмник CommerceML — сборка из корня монорепо:
#   docker build -f packages/backend/Dockerfile .
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/backend/package.json packages/backend/
COPY packages/frontend/package.json packages/frontend/
RUN npm ci
COPY tsconfig.base.json ./
COPY packages/backend/tsconfig.json packages/backend/
COPY packages/backend/src packages/backend/src
RUN npm run build -w @fa/backend && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/backend/node_modules ./packages/backend/node_modules
COPY --from=build /app/packages/backend/dist ./packages/backend/dist
COPY packages/backend/package.json ./packages/backend/
COPY packages/backend/migrations ./packages/backend/migrations
RUN mkdir -p /app/spool && chown -R node:node /app
USER node
ENV EXCHANGE_SPOOL_DIR=/app/spool
EXPOSE 3000
CMD ["node", "packages/backend/dist/index.js"]
