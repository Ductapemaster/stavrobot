# Architecture

This document describes the architecture of Stavrobot, a single-user personal AI assistant. It is the authoritative reference for how the system works. Keep it updated when the architecture changes.

## System overview

Stavrobot is an LLM-powered personal assistant that runs as a set of Docker containers. The user interacts with it via a CLI client, Signal, or Telegram. The LLM agent (Anthropic Claude) has access to a PostgreSQL database, a plugin system, sandboxed Python execution, web search/fetch, cron scheduling, text-to-speech, speech-to-text, and a self-programming subsystem that can create new tools at runtime.

All messages flow through a single `POST /chat` endpoint on the main app. The agent processes one message at a time via an in-memory queue.

## Containers

Seven containers are defined in `docker-compose.yml`. The signal-bridge is behind a Docker Compose profile and only starts when explicitly enabled.

### app (port 3000 external, 3001 internal)

The main TypeScript HTTP server. Built with a multi-stage Dockerfile: the build stage compiles TypeScript, the production stage copies only compiled JS and production dependencies. Runs on Node.js 22. Installs `faad` and `lame` for audio format conversion (STT pipeline).

**Two HTTP servers run in this container:**

- **Port 3000 (external):** All user-facing endpoints. Protected by HTTP Basic Auth (password from `config.toml`). Public route exceptions are whitelisted in `isPublicRoute()`: the Telegram webhook (`POST /telegram/webhook`), pages (`GET /pages/*`), and page queries (`GET /api/pages/*/queries/*`). Pages and page queries enforce per-row auth in their handlers (checking `is_public`).

- **Port 3001 (internal):** An unauthenticated HTTP server that only accepts `POST /chat`. Used for inter-service callbacks from the signal-bridge, plugin-runner, and coder containers. This avoids distributing the app password to every container. Network-level isolation (Docker internal networking) provides the security boundary.

**Entrypoint:** `entrypoint.sh` runs as root, `chmod 600` the config file (so the Node process running as root can read it but it's protected), makes the data directory world-writable, then execs the Node process.

### postgres

PostgreSQL 17. Health-checked with `pg_isready`. The app waits for it to be healthy before starting. Data is persisted to `./data/postgres`.

### plugin-runner (port 3003)

A Node.js 22 HTTP server that manages and executes plugins. Has no LLM. Built with a multi-stage Dockerfile. The production image includes `uv`, `python3`, `git`, `openssh-client`, `curl`, and `build-essential` so plugins can use any of these runtimes.

Handles both git-installed plugins and locally created (editable) plugins. Creates a dedicated Unix system user per plugin (`plug_<name>`) and restricts each plugin's directory with `chmod 700`, so plugins cannot read each other's files or configuration.

Mounts: `./data/main:/config` (reads config.toml for the app password), `./data/plugins:/plugins`, `./cache/plugins:/cache`.

### coder (port 3002)

A Python HTTP server that wraps the `claude` CLI (Claude Code headless). Receives coding tasks for specific plugins, spawns `claude -p` as a subprocess running as the plugin's Unix user, and posts results back to the app via `POST` to `app:3001/chat`.

Built on `debian:bookworm-slim` with `uv`, `python3`, `git`, and the Claude CLI installed. Creates a `coder` user (UID 9999) for installing the Claude CLI, but the server itself runs as root so it can switch to different plugin users per task.

**Entrypoint:** Runs as root. Reads `config.toml`, extracts `[coder].model` into `/run/coder-env` (chmod 600), then execs the Python server. The LLM subprocess cannot read `config.toml` directly.

**Credential management:** Before each task, copies `.credentials.json` from `/home/coder/.claude/` into the plugin directory (owned by the plugin user). After the task, copies refreshed credentials back and cleans up. Validates that the `.claude` directory in the plugin is not a symlink to prevent credential theft.

Mounts: `./data/main:/config`, `./data/coder:/home/coder/.claude`, `./data/plugins:/plugins`, `./cache/plugins:/cache`.

### python-runner (port 3003)

A Python HTTP server that executes arbitrary Python code via `uv run`. Accepts `POST /run` with `{ code, dependencies }`. Creates a `pythonrunner` system user and runs all scripts as that user. 30-second timeout with SIGTERM/SIGKILL escalation.

No volume mounts. Completely isolated from the app filesystem.

### signal-bridge (port 8081 internal)

A Python script that bridges Signal messages to the agent. Only starts when the `signal` Docker Compose profile is enabled. Runs `signal-cli` as a subprocess in daemon mode with an HTTP API on port 8080 (internal to the container). Listens to the SSE event stream for incoming messages.

**Dual role:**
- **Inbound:** Receives Signal messages via SSE, forwards them to `app:3001/chat` with `source: "signal"`.
- **Outbound:** Exposes `POST /send` on port 8081 for the app's `send_signal_message` tool to call. Converts markdown to Signal text styles. Supports text and file attachments.

Mounts: `./data/main/config.toml:/app/config.toml:ro`, `./data/signal-cli:/root/.local/share/signal-cli`.

### pg-backup

A PostgreSQL 17 container that runs `pg_dump | gzip` on a configurable interval (default: daily). Implements a retention policy: keeps the 30 most recent backups, plus one per month for 12 months, plus one per year forever.

Mounts: `./scripts:/scripts:ro`, `./data/db-backups:/backups`.

## Message flow

### Inbound message processing

All messages enter through `POST /chat` (either the external port 3000 with auth, or the internal port 3001 without auth). The request body is JSON with these fields:

- `message` (string, optional): Text message.
- `audio` (string, optional): Base64-encoded audio data.
- `audioContentType` (string, optional): MIME type of the audio.
- `attachments` (array, optional): Pre-saved file attachments with `storedPath`, `originalFilename`, `mimeType`, `size`.
- `files` (array, optional): Raw file data as base64 with `data`, `filename`, `mimeType`. Used by the signal-bridge which cannot write to the app container's filesystem.
- `source` (string, optional): Where the message came from (`"cli"`, `"signal"`, `"telegram"`, `"cron"`, `"coder"`, `"upload"`, `"plugin:name/tool"`).
- `sender` (string, optional): Identifier of the sender (phone number, chat ID, etc.).

At least one of `message`, `audio`, `attachments`, or `files` must be present.

### Message queue

Messages are processed sequentially through an in-memory queue (`queue.ts`). Only one message is processed at a time. The queue handles retries (up to 3 retries with 30-second delays) and special error handling for auth failures (sends login links via the originating channel) and 400 errors (non-retryable).

### Agent processing

`handlePrompt()` in `agent.ts` is the core processing function:

1. If a background compaction just completed, reloads messages from the database.
2. Loads all memories and scratchpad titles from the database.
3. Builds the system prompt: base prompt + custom prompt + public hostname/timezone suffix + plugin list + memories + scratchpad titles.
4. Transcribes audio via OpenAI STT if present.
5. Reads image attachments into base64 for vision.
6. Formats the user message with metadata: `Time`, `Source`, `Sender`, `Text`.
7. Validates API key/OAuth credentials before entering the agent loop.
8. Subscribes to agent events to persist messages to the database as they complete.
9. Calls `agent.prompt()` which runs the LLM with tool use in a loop until the agent stops.
10. After completion, triggers background compaction if message count exceeds 40.

### Outbound message delivery

The agent does not directly reply to Signal or Telegram users. The system prompt instructs the agent that when `Source` is `"signal"` or `"telegram"`, the text response is never delivered — the agent must use `send_signal_message` or `send_telegram_message` tools to reach the user. For CLI source, the text response is returned in the HTTP response body.

### Telegram webhook flow

1. Telegram sends updates to `POST /telegram/webhook` (public, no auth).
2. The handler responds 200 immediately (Telegram requires fast responses).
3. Downloads voice notes, photos, or documents from the Telegram API.
4. Enqueues the message with `source: "telegram"` and the chat ID as sender.
5. The agent processes it and uses `send_telegram_message` to reply.

### Signal bridge flow

1. `signal-cli` receives a Signal message and emits it via SSE.
2. The bridge reads the SSE stream, extracts text/audio/attachments.
3. Forwards to `app:3001/chat` with `source: "signal"` and the phone number as sender.
4. The agent processes it and uses `send_signal_message` to reply.
5. `send_signal_message` calls `POST http://signal-bridge:8081/send`.
6. The bridge sends via `signal-cli`'s JSON-RPC API.

### Coder async flow

1. The agent calls `request_coding_task` with a plugin name and message.
2. The tool validates the plugin is editable, then sends `POST http://coder:3002/code` with `{ taskId, plugin, message }`.
3. The coder returns 202 immediately.
4. In a background thread, the coder spawns `claude -p` as the plugin's Unix user.
5. On completion, posts the result to `app:3001/chat` with `source: "coder"`.

### Plugin async tool flow

1. The agent calls `run_plugin_tool` for a tool marked `async: true`.
2. The plugin-runner returns 202 immediately.
3. The tool script runs in the background (5-minute timeout).
4. On completion, the plugin-runner posts the result to `app:3001/chat` with `source: "plugin:name/tool"`.

## Database schema

All tables are created with `CREATE TABLE IF NOT EXISTS` on startup. The schema is managed by the app, not by migrations.

### messages

Stores the full conversation history. Each row is a single agent message (user, assistant, or toolResult) serialized as JSONB.

| Column | Type | Description |
|--------|------|-------------|
| id | SERIAL PRIMARY KEY | Auto-incrementing ID |
| role | TEXT | Message role |
| content | JSONB | Full message content |
| created_at | TIMESTAMPTZ | Timestamp |

### memories

The agent's self-managed memory store. Full content is injected into the system prompt every turn.

| Column | Type | Description |
|--------|------|-------------|
| id | SERIAL PRIMARY KEY | Auto-incrementing ID |
| content | TEXT | Memory content |
| created_at | TIMESTAMPTZ | Creation timestamp |
| updated_at | TIMESTAMPTZ | Last update timestamp |

### scratchpad

Second-tier knowledge store. Only titles are injected into the system prompt; bodies are read on demand via SQL.

| Column | Type | Description |
|--------|------|-------------|
| id | SERIAL PRIMARY KEY | Auto-incrementing ID |
| title | TEXT | Short descriptive title |
| body | TEXT | Full content |
| created_at | TIMESTAMPTZ | Creation timestamp |
| updated_at | TIMESTAMPTZ | Last update timestamp |

### compactions

Stores conversation summaries created by background compaction.

| Column | Type | Description |
|--------|------|-------------|
| id | SERIAL PRIMARY KEY | Auto-incrementing ID |
| summary | TEXT | Compacted conversation summary |
| up_to_message_id | INTEGER FK | Last message ID included in this compaction |
| created_at | TIMESTAMPTZ | Timestamp |

### cron_entries

Scheduled tasks managed by the agent. Either recurring (cron expression) or one-shot (fire_at datetime). A CHECK constraint enforces mutual exclusivity.

| Column | Type | Description |
|--------|------|-------------|
| id | SERIAL PRIMARY KEY | Auto-incrementing ID |
| cron_expression | TEXT | Cron expression (nullable) |
| fire_at | TIMESTAMPTZ | One-shot fire time (nullable) |
| note | TEXT | The message/instruction for this entry |
| created_at | TIMESTAMPTZ | Timestamp |

### pages

Web pages created by the agent, served at `GET /pages/<path>`.

| Column | Type | Description |
|--------|------|-------------|
| id | SERIAL PRIMARY KEY | Auto-incrementing ID |
| path | TEXT UNIQUE | URL path |
| mimetype | TEXT | MIME type |
| data | BYTEA | Page content |
| is_public | BOOLEAN | Whether auth is required |
| queries | JSONB | Named SQL queries for dynamic data |
| created_at | TIMESTAMPTZ | Creation timestamp |
| updated_at | TIMESTAMPTZ | Last update timestamp |

## Agent tools

The agent has access to these tools, conditionally enabled based on configuration:

**Always available:**
- `execute_sql` — Run arbitrary SQL against PostgreSQL.
- `manage_knowledge` — Upsert/delete entries in the memory or scratchpad stores.
- `send_signal_message` — Send text or attachments via Signal.
- `manage_cron` — Create, update, delete, or list scheduled cron entries.
- `run_python` — Execute Python code in the sandboxed python-runner.
- `manage_pages` — Create, update, or delete web pages with optional named queries.
- `manage_uploads` — Read or delete uploaded files.
- `manage_files` — Write, read, list, or delete files in an ephemeral temp directory (`/tmp/stavrobot-temp/files/`). Supports utf-8 and base64 encodings. File paths can be passed as `attachmentPath` to `send_signal_message` or `send_telegram_message`.
- `manage_plugins` — Install, update, remove, configure, list, or show plugins.
- `run_plugin_tool` — Execute a plugin tool.

**Conditionally available:**
- `web_search` — Search the web via Anthropic's server-side web search tool (requires `[webSearch]` config).
- `web_fetch` — Fetch a URL and process its content with an LLM (requires `[webFetch]` config).
- `text_to_speech` — Convert text to speech via OpenAI TTS API (requires `[tts]` config).
- `send_telegram_message` — Send text or attachments via Telegram (requires `[telegram]` config).
- `request_coding_task` — Send coding tasks to the coder agent (requires `[coder]` config).

Action-based tools (`manage_knowledge`, `manage_cron`, `manage_files`, `manage_pages`, `manage_uploads`, `manage_plugins`) support a `help` action that returns detailed documentation.

## Conversation compaction

When the in-memory message count exceeds 40, a background compaction is triggered:

1. Finds a safe cut point at a user message boundary (to avoid orphaning tool-result messages).
2. Serializes the older messages into a text summary.
3. Calls the LLM (same model) to produce a concise summary.
4. Saves the summary to the `compactions` table with the boundary message ID.
5. On the next prompt, reloads messages from the database: a synthetic user message with the summary, followed by the messages after the boundary.

A boolean flag prevents concurrent compaction runs. The compaction runs in a fire-and-forget async block.

## Plugin system

### Plugin structure

A plugin is a directory containing:
- `manifest.json` at the root: `{ name, description, config?, instructions?, init? }`.
- Tool subdirectories, each with their own `manifest.json`: `{ name, description, entrypoint, async?, parameters }`.
- Optional `config.json` for runtime configuration (not committed to git).

Plugin names must match `[a-z0-9-]+`.

### Plugin types

- **Git-installed:** Cloned from a git URL. Cannot be modified by the coder agent. Managed with `manage_plugins`.
- **Editable (locally created):** Created via `manage_plugins (action: create)`. Can be modified by the coder agent via `request_coding_task`. Distinguished by the absence of a `.git` directory.

### Plugin isolation

Each plugin gets a dedicated Unix system user (`plug_<name>` with hyphens replaced by underscores). The plugin directory is `chown`ed to this user and `chmod 700`ed. This means:
- Plugins cannot read each other's files or configuration.
- Plugin tools run as their plugin's user.
- The plugin-runner creates matching users in both the plugin-runner and coder containers.

### Tool execution

Tools are executable scripts. The plugin-runner spawns them as subprocesses:
- Working directory: the tool's subdirectory.
- Parameters passed as JSON on stdin.
- Output expected as JSON on stdout.
- Environment: only `PATH`, `UV_CACHE_DIR`, `UV_PYTHON_INSTALL_DIR`.
- Sync tools: 30-second timeout, result returned inline.
- Async tools: 5-minute timeout, result posted back via callback to `app:3001/chat`.

### Init scripts

Declared in the plugin manifest. Run on both install and update. Can be sync (30s timeout, blocks the operation) or async (5min timeout, runs in background). Output is captured and returned to the agent.

## Authentication

### External HTTP auth

All endpoints on port 3000 require HTTP Basic Auth by default. The password comes from `config.toml`. Exceptions are whitelisted in `isPublicRoute()`:
- `POST /telegram/webhook` — Telegram needs to reach this without auth.
- `GET /pages/*` — Routable without auth, but the handler enforces per-page auth based on `is_public`.
- `GET /api/pages/*/queries/*` — Same per-page auth pattern.

### LLM API auth

Two modes:
- **API key:** Static key from `config.toml`.
- **OAuth (authFile):** For Claude Pro/Max subscriptions. Credentials stored in a JSON file. The `getApiKey()` function handles token refresh with exponential backoff (3 retries). A web-based login flow at `/providers/anthropic/login` handles the OAuth PKCE flow.

### Plugin config auth

The plugin-runner's `GET /bundles/:name/config` endpoint is protected by a Bearer token (the app password). This endpoint returns actual config values which may contain secrets. It is only called by the app's admin UI proxy, never exposed to the LLM agent.

The LLM agent can write config via `configure_plugin` but can never read config values back. When reporting config status, only key presence/absence is reported, never values.

## Security model

### Container isolation

- The app container has no code execution runtimes (no Python, no uv). All code execution happens in separate containers.
- No shared filesystem mounts between the app and runner containers.
- The Docker socket is never mounted into any container.
- No tool gives the LLM the ability to read arbitrary files from the app container.

### Secret isolation

- The app's `entrypoint.sh` runs `chmod 600` on `config.toml` before starting the Node process.
- The coder's `entrypoint.sh` runs `chmod 600` on `config.toml`, extracts only the model name into `/run/coder-env`, then starts the server. The LLM subprocess cannot read `config.toml`.
- The plugin-runner reads the app password from `config.toml` at startup, then `chmod 600`s it.
- Plugin `config.json` files may contain secrets. No API endpoint or tool returns config values to the LLM agent.

### Inter-service communication

- The internal server on port 3001 has no authentication. Security relies on Docker network isolation — only containers in the same Docker Compose network can reach it.
- The signal-bridge, plugin-runner, and coder all post callbacks to `app:3001/chat`.

### Input validation

- Plugin names are validated against `[a-z0-9-]+` to prevent path traversal, shell injection, and username derivation issues.
- Page queries are validated as read-only SQL (must start with SELECT or WITH, no multi-statement injection).
- Upload file paths are validated to be within the uploads directory.
- Telegram chat IDs and Signal phone numbers are checked against allowlists.

## Configuration

Runtime configuration is loaded from `config.toml` (or the path in `CONFIG_PATH` env var). The file is gitignored; `config.example.toml` is the template.

### Required fields

- `provider` — LLM provider (e.g., `"anthropic"`).
- `model` — Model name.
- `publicHostname` — Public HTTPS URL (no trailing slash).
- Either `apiKey` or `authFile` (mutually exclusive).

### Optional fields

- `password` — HTTP Basic Auth password for all endpoints.
- `customPrompt` — Additional instructions appended to the base system prompt.
- `[tts]` — Text-to-speech (OpenAI API).
- `[stt]` — Speech-to-text (OpenAI API).
- `[webSearch]` — Web search sub-agent.
- `[webFetch]` — Web fetch sub-agent.
- `[coder]` — Self-programming agent (Claude Code model alias).
- `[telegram]` — Telegram bot integration.
- `[signal]` — Signal integration (read by signal-bridge, not the app).

## File structure

```
src/
  index.ts          — HTTP server, routing, entry point. Two servers: external (3000) and internal (3001).
  config.ts         — Loads config.toml and Postgres config from environment.
  database.ts       — PostgreSQL connection, schema initialization, CRUD for all tables.
  agent.ts          — Agent creation, tool definitions, prompt handling, compaction.
  queue.ts          — Sequential message processing queue with retry logic.
  scheduler.ts      — Cron scheduler that fires entries and cleans up old uploads.
  auth.ts           — API key resolution and OAuth token refresh.
  login.ts          — OAuth PKCE login flow web UI.
  telegram.ts       — Telegram webhook handling and markdown-to-HTML conversion.
  telegram-api.ts   — Low-level Telegram sendMessage API call.
  signal.ts         — Low-level Signal bridge send call.
  plugins.ts        — Plugin management web UI and proxy endpoints.
  plugin-tools.ts   — Agent tools for plugin management and execution.
  python.ts         — Agent tool for sandboxed Python execution.
  web-search.ts     — Agent tool for web search via Anthropic API.
  web-fetch.ts      — Agent tool for URL fetching and LLM analysis.
  stt.ts            — Speech-to-text via OpenAI API with audio format conversion.
  pages.ts          — Agent tool for page management.
  uploads.ts        — File upload handling and storage.
  upload-tools.ts   — Agent tool for upload management.
  explorer.ts       — Database explorer web UI and API.

plugin-runner/
  src/index.ts      — Plugin runner server (manages, executes plugins).
  Dockerfile        — Multi-stage build with uv, python3, git, build-essential.

coder/
  server.py         — Coder HTTP server (spawns claude -p).
  entrypoint.sh     — Secret extraction and server startup.
  system-prompt.txt — System prompt for the coder agent.
  PLUGIN.md         — Plugin authoring guide (used by the coder agent).
  Dockerfile        — Debian with uv, python3, git, Claude CLI.

python-runner/
  server.py         — Python execution server.
  Dockerfile        — Python 3.13 with uv.

signal-bridge/
  bridge.py         — Signal-to-agent bridge.
  markdown_to_signal.py — Markdown to Signal text style conversion.
  Dockerfile        — Debian with signal-cli and python3.

scripts/
  pg-backup.sh      — Database backup with retention policy.

client.py           — Python CLI client (standalone, no dependencies).
system-prompt.txt   — Base system prompt for the main agent.
config.example.toml — Configuration template.
entrypoint.sh       — App container entrypoint.
```

## Deployment

- Single-user system. One person chats with it at a time.
- Deployed via `docker compose up --build`.
- `docker-compose.harbormaster.yml` is an override file for the Harbormaster deployment system, replacing `./data` paths with `{{ HM_DATA_DIR }}` and `./cache` with `{{ HM_CACHE_DIR }}`.
- The app listens on port 3000 internally, mapped to 10567 externally.
- Postgres credentials default to `stavrobot`/`stavrobot`/`stavrobot`, configurable via environment variables.

## Key libraries

- `@mariozechner/pi-ai` — LLM abstraction (models, types, OAuth, completion).
- `@mariozechner/pi-agent-core` — Agent framework (tool loop, message management, subscriptions).
- `pg` — PostgreSQL client.
- `@iarna/toml` — TOML parser for config.
- `busboy` — Multipart form data parsing for file uploads.
- `cron-parser` — Cron expression parsing for the scheduler.
- `marked` — Markdown parsing for Telegram HTML conversion.
