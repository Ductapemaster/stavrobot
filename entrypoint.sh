#!/bin/sh
set -e
chmod 600 "${CONFIG_PATH:-/app/config.toml}"
chmod o+rwx /app/data
exec "$@"
