FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ARG APP selects the entrypoint: api | realtime | worker
# Healthchecks and ports are declared per-service in docker-compose.yml;
# all three apps serve HTTP (api: full surface, realtime/worker: /healthz
# and /metrics on their own ports).
FROM node:22-alpine AS runner
ARG APP=api
ENV APP_NAME=${APP}
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
COPY drizzle.config.ts ./
USER node
# Bounded heap: containers fail fast on leaks instead of OOM-killing the host.
CMD ["sh", "-c", "exec node --max-old-space-size=512 dist/apps/${APP_NAME}.main.js"]
