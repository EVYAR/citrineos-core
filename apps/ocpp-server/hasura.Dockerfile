# SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
#
# SPDX-License-Identifier: Apache-2.0
FROM hasura/graphql-engine:v2.40.3.cli-migrations-v3
ARG COMMIT_SHA
LABEL org.opencontainers.image.revision=$COMMIT_SHA
LABEL org.opencontainers.image.title="citrineos-core-hasura-metadata"

# Bundle metadata into the image so Dokploy Dockerfile mode works
# without compose bind mounts.
COPY ./db/hasura-metadata /hasura-metadata
