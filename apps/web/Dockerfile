# syntax=docker/dockerfile:1
# Build context is the REPOSITORY ROOT (see apps/api/Dockerfile for why).

FROM node:22-alpine AS base
WORKDIR /app
RUN apk add --no-cache libc6-compat

# ---- dependencies -----------------------------------------------------------
FROM base AS deps
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci

# ---- build ------------------------------------------------------------------
FROM deps AS build
ENV NEXT_TELEMETRY_DISABLED=1
COPY tsconfig.base.json ./
COPY apps/web apps/web
RUN npm run build --workspace @limaz/web

# ---- runtime ----------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Next's `standalone` output is deliberately not used here. In a workspace it
# needs outputFileTracingRoot plus a nested copy layout, which is a known
# source of broken images. A larger image that reliably starts is the better
# trade for this project; it is recorded as a known limitation in the README.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/apps/web ./apps/web

RUN chown -R node:node /app
USER node

EXPOSE 3000
CMD ["npm", "run", "start", "--workspace", "@limaz/web"]
