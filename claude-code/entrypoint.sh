#!/bin/bash
set -e

chmod 600 /config/config.toml
chown coder:coder /home/coder/.claude

python3 - <<'EOF'
import tomllib

with open("/config/config.toml", "rb") as f:
    config = tomllib.load(f)

password = config.get("password", "")
coder_section = config.get("coder", {})
model = coder_section["model"]

with open("/run/coder-env", "w") as f:
    f.write(f"PASSWORD={password}\n")
    f.write(f"MODEL={model}\n")
EOF

chmod 600 /run/coder-env
chown coder:coder /run/coder-env

exec su -s /bin/bash coder -c "python3 /app/server.py"
