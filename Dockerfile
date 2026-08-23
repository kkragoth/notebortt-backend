FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
COPY drizzle.config.ts ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s CMD wget -qO- http://localhost:3000/health/live || exit 1
CMD ["node", "dist/index.js"]
