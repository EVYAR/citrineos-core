# SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
#
# SPDX-License-Identifier: Apache-2.0

# Build context is the monorepo root.

FROM --platform=${BUILDPLATFORM:-linux/amd64} node:24.16.0 AS builder

RUN corepack enable

WORKDIR /app

COPY . .

RUN pnpm install --frozen-lockfile
ARG NEXT_PUBLIC_APP_NAME
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_WS_URL
ARG NEXT_PUBLIC_CITRINE_CORE_URL
ARG NEXT_PUBLIC_FILE_SERVER_URL
ARG NEXT_PUBLIC_AUTH_PROVIDER
ARG NEXT_PUBLIC_TENANT_ID
ARG NEXT_PUBLIC_HASURA_CLAIM
ARG NEXT_PUBLIC_ADMIN_EMAIL
ARG NEXT_PUBLIC_KEYCLOAK_URL
ARG NEXT_PUBLIC_LOGO_URL
ARG NEXT_PUBLIC_BANNER_MESSAGE
ARG NEXT_PUBLIC_HELP_VIDEO_URL
ARG NEXT_PUBLIC_GOOGLE_MAPS_LOCATION_PICKER_MAP_ID
ARG NEXT_PUBLIC_GOOGLE_MAPS_OVERVIEW_MAP_ID
ARG NEXT_PUBLIC_DEFAULT_MAP_CENTER_LATITUDE
ARG NEXT_PUBLIC_DEFAULT_MAP_CENTER_LONGITUDE
ENV NEXT_PUBLIC_APP_NAME=${NEXT_PUBLIC_APP_NAME}
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
ENV NEXT_PUBLIC_WS_URL=${NEXT_PUBLIC_WS_URL}
ENV NEXT_PUBLIC_CITRINE_CORE_URL=${NEXT_PUBLIC_CITRINE_CORE_URL}
ENV NEXT_PUBLIC_FILE_SERVER_URL=${NEXT_PUBLIC_FILE_SERVER_URL}
ENV NEXT_PUBLIC_AUTH_PROVIDER=${NEXT_PUBLIC_AUTH_PROVIDER}
ENV NEXT_PUBLIC_TENANT_ID=${NEXT_PUBLIC_TENANT_ID}
ENV NEXT_PUBLIC_HASURA_CLAIM=${NEXT_PUBLIC_HASURA_CLAIM}
ENV NEXT_PUBLIC_ADMIN_EMAIL=${NEXT_PUBLIC_ADMIN_EMAIL}
ENV NEXT_PUBLIC_KEYCLOAK_URL=${NEXT_PUBLIC_KEYCLOAK_URL}
ENV NEXT_PUBLIC_LOGO_URL=${NEXT_PUBLIC_LOGO_URL}
ENV NEXT_PUBLIC_BANNER_MESSAGE=${NEXT_PUBLIC_BANNER_MESSAGE}
ENV NEXT_PUBLIC_HELP_VIDEO_URL=${NEXT_PUBLIC_HELP_VIDEO_URL}
ENV NEXT_PUBLIC_GOOGLE_MAPS_LOCATION_PICKER_MAP_ID=${NEXT_PUBLIC_GOOGLE_MAPS_LOCATION_PICKER_MAP_ID}
ENV NEXT_PUBLIC_GOOGLE_MAPS_OVERVIEW_MAP_ID=${NEXT_PUBLIC_GOOGLE_MAPS_OVERVIEW_MAP_ID}
ENV NEXT_PUBLIC_DEFAULT_MAP_CENTER_LATITUDE=${NEXT_PUBLIC_DEFAULT_MAP_CENTER_LATITUDE}
ENV NEXT_PUBLIC_DEFAULT_MAP_CENTER_LONGITUDE=${NEXT_PUBLIC_DEFAULT_MAP_CENTER_LONGITUDE}

ARG COMMIT_SHA
RUN node -e 'const fs = require("node:fs"); const pkg = JSON.parse(fs.readFileSync("apps/operator-ui/package.json", "utf8")); const sourceSha = process.env.COMMIT_SHA || null; if (sourceSha && !/^[a-f0-9]{40}$/.test(sourceSha)) throw new Error("COMMIT_SHA must be a full source SHA"); fs.writeFileSync("apps/operator-ui/public/build-info.json", JSON.stringify({component: pkg.name, version: pkg.version, sourceSha}) + "\n");'
RUN NODE_OPTIONS=--max-old-space-size=2048 pnpm --workspace-concurrency=1 --filter "@citrineos/operator-ui..." build

FROM node:24.16.0-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

RUN addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 nextjs

# Next.js standalone output is rooted at outputFileTracingRoot (monorepo root),
# so server.js lives at apps/operator-ui/server.js within the standalone tree.
COPY --from=builder --chown=nextjs:nodejs /app/apps/operator-ui/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/operator-ui/.next/static ./apps/operator-ui/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/apps/operator-ui/public ./apps/operator-ui/public

USER nextjs

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

ARG COMMIT_SHA
LABEL org.opencontainers.image.revision=$COMMIT_SHA

CMD ["node", "apps/operator-ui/server.js"]
