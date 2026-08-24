FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ARG APP selects the entrypoint: api | realtime | worker
# Healthchecks and ports are declared per-service in docker-compose.yml
# because only `api` serves HTTP health endpoints.
FROM node:22-alpine AS runner
ARG APP=api
ENV APP_NAME=${APP}
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
COPY drizzle.config.ts ./
USER node
CMD ["sh", "-c", "exec node dist/apps/${APP_NAME}.main.js"]
