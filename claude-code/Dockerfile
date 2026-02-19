FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    git \
    python3 \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -m -u 9999 coder

USER coder
RUN curl -fsSL https://claude.ai/install.sh | bash
ENV PATH="/home/coder/.local/bin:${PATH}"

USER root
COPY entrypoint.sh server.py system-prompt.txt /app/
RUN chmod +x /app/entrypoint.sh

EXPOSE 3002
ENTRYPOINT ["/app/entrypoint.sh"]
