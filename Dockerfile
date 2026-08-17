FROM node:22-slim AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run typecheck

FROM node:22-slim

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY package*.json tsconfig.json ./
COPY src ./src
COPY contracts ./contracts
COPY scripts ./scripts

# Durable encrypted books live here; mount a volume in production.
RUN mkdir -p /app/data

# The ephemeral epoch journal must be memory-backed in production
# (PX402_PRIVATE_LEDGER_REQUIRE_TMPFS defaults to true). Mount a tmpfs at the
# journal directory, e.g.:
#   docker run --tmpfs /dev/shm/px402 -e PX402_PRIVATE_LEDGER_EPHEMERAL_DIR=/dev/shm/px402 ...

EXPOSE 8787 3099

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npx", "tsx", "src/server/index.ts"]
