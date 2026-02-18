#!/bin/sh
set -e
chmod 600 /app/config.toml
chmod o+rwx /app/data
exec "$@"
