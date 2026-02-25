# Skill authoring guide

Skills are plain-text markdown instruction files that teach Stavrobot new capabilities.
They are not code. The bot reads a skill file and follows its instructions using its
existing tools: creating database tables, building web pages, storing knowledge entries,
scheduling cron jobs, and installing plugins. A skill author describes *what* to set up;
the bot figures out *how* to implement it.

This guide covers everything you need to write a complete skill from scratch.

---

## File format

Skill files live in `skills/` on the `pages` branch of this repo and are named with
short, descriptive, kebab-case names (e.g. `gym.md`, `meal-planning.md`, `finance.md`).
The bootstrap file lives in `skills/` as `skills/bootstrap.md`, like every other skill.

Every skill file has two parts: a YAML front matter block and a body.

### Front matter

The front matter is enclosed in `---` delimiters at the very top of the file:

```yaml
---
title: Gym tracking
description: Track workouts, exercises, body measurements, and view progress over time.
version: 1
author: Stavros Korokithakis
---
```

| Field | Required | Description |
|-------|----------|-------------|
| `title` | Yes | Human-readable name shown in the skill index |
| `description` | Yes | One-line summary of what the skill does |
| `version` | Yes | Integer, starting at 1. Increment on every change. |
| `author` | No | Who wrote the skill |

### Body

The body is plain-language instructions addressed directly to the bot. Use numbered
steps with markdown headers (`## Step 1: ...`). The bot follows the steps in order.

The last step must always record the skill in the `skills` table (see
[Recording the skill](#recording-the-skill) below).

See `skills/gym.md` on the `pages` branch for a complete example of a domain skill, and
`skills/bootstrap.md` for the bootstrap skill that sets up the skill system itself.

---

## Systems available to skills

### Database tables

The bot has full read/write access to PostgreSQL via the `execute_sql` tool. Skills
describe tables in plain language; the bot generates the actual SQL.

**How to describe a table in a skill:**

List the table name, then each column with its type, whether it is nullable, any default
value, and any constraints (primary key, foreign key, unique). Use "if not exists"
language so the skill is safe to re-run.

Example from `skills/gym.md`:

```
**`workouts`** — A single gym session.
- `id` (serial, primary key)
- `date` (date)
- `notes` (text) — how the session felt, energy level, etc.
- `duration_minutes` (integer, nullable)
```

**Column type guidance:**

- Use `text` for strings (never `varchar` with a length limit unless there is a real
  reason to cap it).
- Use `serial` for auto-incrementing integer primary keys.
- Use `integer` or `numeric` for numbers. Use `numeric` when precision matters (weights,
  money).
- Use `date` for calendar dates, `timestamptz` for timestamps with timezone.
- Use `boolean` for true/false values.
- Mark columns `nullable` explicitly when they may be absent. If a column is not marked
  nullable, the bot will create it as `NOT NULL`.

**Foreign keys:** Describe them as "references `other_table`" or "references
`other_table(column)`". The bot will generate the constraint.

**Idempotency:** Always phrase table creation as "create if not exists". This means the
skill can be installed more than once or re-run after a partial failure without breaking
anything.

---

### Pages

The bot can create web pages served at `/pages/<path>` using the `upsert_page` tool.
Pages support live data via named SQL queries.

**How pages work:**

- A page is an HTML document stored in the database and served by the app.
- Pages can be private (requires authentication, the default) or public (no auth).
- Named queries are SQL strings stored alongside the page. The page's JavaScript fetches
  live data by calling `GET /api/pages/<path>/queries/<name>`. For public pages, these
  query endpoints are also public. For private pages, the browser is already authenticated
  by the page load, so the query endpoints work without extra credentials.
- Query parameters use `$param:name` placeholders in the SQL. The client passes values
  via query string (e.g. `?name=squat`).

**How to describe a page in a skill:**

Describe what the page should show and what queries it needs. Do not write HTML or
JavaScript — the bot generates the implementation. Be specific about the data (which
tables, which columns, what ordering, what filters) but leave the visual design to the
bot.

Example from `skills/gym.md`:

```
**`/pages/gym`** — Main dashboard.

Show the latest body measurement at the top of the page. Below that, list the most
recent 10 workouts in reverse chronological order. For each workout, show the date,
duration (if set), any notes, and a breakdown of every set performed: exercise name,
set number, reps, weight, and set notes.

Define two named queries:
- `recent_workouts`: returns the 10 most recent workouts joined with their sets and
  the exercise name, ordered by workout date descending then by set number ascending.
- `latest_measurement`: returns the single most recent row from `body_measurements`.
```

**Parameterized queries:**

When a query depends on user input (e.g. selecting an exercise from a dropdown), describe
the parameter by name. The bot will use `$param:name` in the SQL and the page's
JavaScript will pass the value via query string.

Example:

```
- `exercise_progress`: parameterized by exercise name; returns the maximum weight
  lifted for that exercise per workout date, ordered by date ascending.
```

**Visibility:** Pages should be private unless there is a specific reason to make them
public. State "all pages must be private" or "this page must be public" explicitly.

---

### Scratchpad

The scratchpad is a second-tier knowledge store managed via the `manage_knowledge` tool
with `store: "scratchpad"`. Each entry has a title and a body. Entry IDs and titles
appear in the bot's context on every turn; bodies are loaded on demand via SQL.

**When to use it:**

Use the scratchpad for reference material, detailed instructions, or domain knowledge
the bot should be able to look up but does not need in context constantly. Examples:
dietary preferences, a list of known exercises, a description of a workflow.

**How to describe a scratchpad entry in a skill:**

Give the entry a title (under 50 characters, descriptive enough to identify the content
at a glance) and specify the body content.

Example:

```
## Step 2: Store dietary preferences in the scratchpad

Create a scratchpad entry titled "Dietary preferences" with the following content:

The user is vegetarian and avoids gluten. They prefer metric units for all measurements.
```

---

### Memories

Memories are managed via `manage_knowledge` with `store: "memory"`. Unlike scratchpad
entries, the full content of every memory is injected into the bot's context on every
single turn.

**When to use it:**

Use memories only for things the bot needs to know constantly — facts that are relevant
to almost every interaction. The bar is high. Most skills should not create memories.
Use the scratchpad instead.

A memory is appropriate when the information would otherwise need to be looked up on
nearly every turn. For example: "User prefers metric units for gym weights" is a
reasonable memory if the user logs workouts daily. A list of 50 exercises is not — that
belongs in the scratchpad.

**How to describe a memory in a skill:**

State the content explicitly. Keep it concise (a few sentences at most).

Example:

```
## Step 2: Store a memory

Create a memory with the following content:

The user tracks gym workouts daily and prefers weights in kilograms.
```

---

### Cron jobs

The bot can schedule recurring or one-shot tasks via the `manage_cron` tool.

- **Recurring:** Use a cron expression (e.g. `0 9 * * *` for 9 AM daily).
- **One-shot:** Use an ISO 8601 datetime string.

Each cron entry has a `note` field — the message or instruction the bot will receive
when the entry fires. Write the note as if you were sending the bot a message at that
time.

**When to use it:**

Use cron for periodic reminders, scheduled data collection, or recurring reports.
Examples: a daily hydration reminder, a weekly summary of workouts, a nightly backup
check.

**How to describe a cron job in a skill:**

Specify the schedule and the note content.

Example:

```
## Step 3: Set up a daily reminder

Create a cron entry with the expression `0 8 * * *` (8 AM every day) and the note:
"Remind the user to log their morning weight measurement."
```

---

### Plugins

Skills can instruct the bot to install plugins from git URLs using the `install_plugin`
tool. Plugins extend the bot with capabilities beyond its built-in tools — for example,
a weather plugin, a calendar integration, or a custom data fetcher.

Official plugins are listed at `https://github.com/orgs/stavrobot/repositories`.

**When to use it:**

Use plugin installation when the skill needs a capability that the bot's built-in tools
cannot provide. If the skill only needs database tables, pages, and knowledge entries,
there is no need for a plugin.

**How to describe plugin installation in a skill:**

Provide the git URL and any configuration the plugin needs.

Example:

```
## Step 2: Install the weather plugin

Install the plugin from `https://github.com/stavrobot/weather-plugin`. After installing,
configure it with the user's preferred location.
```

---

## Skill structure conventions

- Address the bot directly: "Create a table...", "Store a scratchpad entry...",
  "Install the plugin from...".
- Use numbered steps with markdown headers: `## Step 1: Create the tables`,
  `## Step 2: Create the pages`, etc.
- The last step must always be "Record the skill" (see below).
- Keep steps focused. One step per system (tables in one step, pages in another, etc.).

### Recording the skill

Every skill must end with a step that inserts a row into the `skills` table. This is how
the bot tracks which skills are installed and at what version, enabling upgrade detection.

```
## Step N: Record the skill

Insert a row into the `skills` table for this skill:

- `name`: "your-skill-name"
- `url`: "https://stavrobot.stavros.io/skills/your-skill-name.md"
- `content`: the full text of this file
- `version`: the version from the front matter of this file
```

The `skills` table is created by the bootstrap skill (`skills/bootstrap.md`). It has
columns: `name` (text, primary key), `url` (text), `content` (text), `version`
(integer), `installed_at` (timestamp), `updated_at` (timestamp).

---

## Design guidance

**One domain per skill.** A skill should focus on a single area: gym tracking, meal
planning, finances. Do not bundle unrelated functionality into one skill. If two domains
share a table, that is a sign they should be separate skills with a shared dependency, or
that the domain boundary needs rethinking.

**Don't overlap with other skills.** Before creating tables, check whether an existing
skill already covers the same domain. Overlapping table names or conflicting schemas will
cause problems on install. The skill index at
`https://stavrobot.stavros.io/skills/index.md` lists all available skills.

**Describe, don't implement.** For pages, describe what they should show and what data
they need — do not write HTML or JavaScript. For tables, describe columns and types — do
not write SQL. The bot generates the implementation from your description. Over-specifying
implementation details wastes space and can constrain the bot unnecessarily.

**Idempotency.** Use "if not exists" language for table creation. A skill should be safe
to install more than once. This also makes partial re-runs safe after a failure.

**Versioning.** Start at version 1. Increment the integer whenever you change the skill.
When the bot detects that the installed version is lower than the fetched version, it
reads the old skill content from the database and the new content from the file, figures
out what changed, and presents a migration summary to the user before applying it. Write
skills so that the migration path is clear from the diff: if you add a column, say so
explicitly in the new version; if you rename a table, note the old name.

**Keep it concise.** The bot is an LLM — it understands intent. Be specific about
*what* (schema, page content, queries) but not *how* (exact SQL, exact HTML). A
well-written skill is readable in under two minutes.

**Private by default.** Pages should be private unless there is a specific reason to
make them public. State visibility explicitly in the skill.

**Memories sparingly.** Most skills should not create memories. If in doubt, use the
scratchpad.

---

## Testing

1. Run `build-pages.sh` to verify the skill appears in the generated index at
   `output/skills/index.md`. This script reads the front matter from every file in
   `skills/` and builds the index table. If your front matter is malformed, the
   entry will be missing or incorrect.

2. Manually tell the bot to fetch and install the skill to test the full flow. The bot
   will fetch the skill file, present a plain-language summary of everything it will do,
   and ask for your approval before making any changes. This approval step is enforced by
   the skill system and cannot be bypassed by anything in the skill file.

---

## Contributing

1. Add the skill file to `skills/` on the `pages` branch.
2. Run `build-pages.sh` and verify the skill appears correctly in
   `output/skills/index.md`.
3. Submit a pull request.

Do not modify `skills/bootstrap.md` unless you are changing the skill system itself.
The bootstrap file is special: it sets up the `skills` table and teaches the bot the
installation and upgrade workflow. Changes to it affect every skill.
