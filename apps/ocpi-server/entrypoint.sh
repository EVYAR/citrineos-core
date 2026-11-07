#!/bin/sh
# SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
#
# SPDX-License-Identifier: Apache-2.0

set -e

OCPI_ENV=${APP_ENV-${OCPI_ENV-docker}}
APP_ENV=$OCPI_ENV
APP_NAME=${APP_NAME:-ocpi}
export OCPI_ENV APP_ENV APP_NAME

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

case "${DB_STRATEGY:-migrate}" in
  migrate)
    (cd "$SCRIPT_DIR" && ./node_modules/.bin/sequelize-cli db:migrate --debug)
    ;;
  none) ;;
  *)
    echo "Unsupported DB_STRATEGY: ${DB_STRATEGY}" >&2
    exit 1
    ;;
esac

echo "Starting application..."
exec node "$SCRIPT_DIR/dist/index.js"
