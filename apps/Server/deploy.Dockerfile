#  SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
#
#  SPDX-License-Identifier: Apache-2.0

# Use a specific base image with platform support
FROM --platform=${BUILDPLATFORM:-linux/amd64} node:24.16.0 AS build

RUN corepack enable

WORKDIR /usr/local/apps/citrineos

# Public npm and nodejs.org are not reliably reachable from our deployment
# environment. Use the approved mirror and bundled Node headers for node-gyp.
RUN npm config set registry https://mirror2.chabokan.net/npm/
ENV npm_config_nodedir=/usr/local

COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter "@citrineos/server..." build

# The final stage, which copies built files and prepares the run environment
# Using a slim image to reduce the final image size
FROM node:24.16.0-slim

RUN corepack enable

COPY --from=build /usr/local/apps/citrineos /usr/local/apps/citrineos

WORKDIR /usr/local/apps/citrineos

RUN chmod +x /usr/local/apps/citrineos/apps/Server/entrypoint.sh

EXPOSE ${PORT}

ENTRYPOINT ["/usr/local/apps/citrineos/apps/Server/entrypoint.sh"]
