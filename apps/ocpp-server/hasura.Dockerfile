# SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
#
# SPDX-License-Identifier: Apache-2.0
FROM hasura/graphql-engine:v2.40.3.cli-migrations-v3

# Bundle metadata into the image so Dokploy Dockerfile mode works
# without compose bind mounts.
COPY ./hasura-metadata /hasura-metadata
