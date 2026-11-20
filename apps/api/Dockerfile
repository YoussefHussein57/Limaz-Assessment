# syntax=docker/dockerfile:1
# Build context is the REPOSITORY ROOT, not apps/api: npm workspaces hoist
# node_modules to the root, so the lockfile and both workspace manifests must
# be visible for a reproducible `npm ci`.

FROM node:22-alpine AS base
WORKDIR /app
RUN apk add --no-cache libc6-compat

# ---- dependencies -----------------------------------------------------------
FROM base AS deps
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
# `npm ci` (not `npm install`) so the image is built from the committed
# lockfile and can never silently resolve a different version.
RUN npm ci

# ---- build ------------------------------------------------------------------
FROM deps AS build
COPY tsconfig.base.json ./
COPY apps/api apps/api
RUN npm run build --workspace @limaz/api

# ---- runtime ----------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production

# The full dependency tree is kept rather than pruned: the entrypoint runs
# `prisma migrate deploy` from F01 onwards, which needs the Prisma CLI at
# runtime. Image size is traded for a single-command startup.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/prisma ./apps/api/prisma
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
# Required at RUNTIME, not just at build time: Prisma 7 reads the connection
# string from this file, so `prisma migrate deploy` in the entrypoint cannot
# run without it.
COPY --from=build /app/apps/api/prisma.config.ts ./apps/api/prisma.config.ts
COPY apps/api/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN chmod +x /usr/local/bin/docker-entrypoint.sh && chown -R node:node /app

# Never run as root.
USER node

EXPOSE 3001
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "apps/api/dist/main.js"]
