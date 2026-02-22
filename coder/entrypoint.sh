#!/bin/bash
set -e

chmod 600 /config/config.toml

python3 - <<'EOF'
import tomllib

with open("/config/config.toml", "rb") as f:
    config = tomllib.load(f)

coder_section = config.get("coder", {})
model = coder_section["model"]

with open("/run/coder-env", "w") as f:
    f.write(f"MODEL={model}\n")
EOF

# The server runs as root so it can switch to different plugin users per task.
chmod 600 /run/coder-env

exec python3 /app/server.py
