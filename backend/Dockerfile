# ── Builder stage ──────────────────────────────────────────────────────────
# Installs all deps, generates the Prisma client, and compiles TS → dist/.
FROM node:22-alpine AS builder

WORKDIR /app

# Install dependencies first so this layer caches when only source changes.
COPY package.json package-lock.json* ./
RUN npm ci

# Copy the rest of the source and build.
COPY . .

# Prisma schema lives at a non-default path — the flag is required.
RUN npx prisma generate --schema=prisma/hermes/schema.prisma
RUN npx tsc

# ── Runner stage ───────────────────────────────────────────────────────────
# Slim runtime image. Carries the compiled output, deps (incl. the Prisma CLI
# used by the migrate-on-boot entrypoint), and the schema/migrations.
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/package.json ./package.json
# Custom-output Prisma client (schema.prisma generator "client" → ../../generated/hermes,
# i.e. backend/generated/hermes) lives outside node_modules, so it needs its own COPY —
# dist/config/prisma.js requires it directly.
COPY --from=builder /app/generated ./generated
# TS source + tsconfig — small (~1.4MB), but needed so `npm run prisma:seed`
# (ts-node prisma/hermes/seed.ts, which imports from ../../src/config/config)
# actually works against a deployed image, not just local dev.
COPY --from=builder /app/src ./src
COPY --from=builder /app/tsconfig.json ./tsconfig.json

EXPOSE 8001

# Apply any pending migrations, then start the server. `migrate deploy` is the
# non-interactive, production-safe variant (no schema diffing or prompts).
CMD ["sh", "-c", "npx prisma migrate deploy --schema=prisma/hermes/schema.prisma && node dist/app.js"]
