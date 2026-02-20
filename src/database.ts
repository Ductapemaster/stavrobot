import pg from "pg";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { PostgresConfig } from "./config.js";

export async function connectDatabase(config: PostgresConfig): Promise<pg.Pool> {
  const pool = new pg.Pool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
  });
  return pool;
}

export async function initializeSchema(pool: pg.Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      role TEXT NOT NULL,
      content JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

export async function initializeMemoriesSchema(pool: pg.Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS memories (
      id SERIAL PRIMARY KEY,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Backfill existing tables that predate the timestamp columns.
  await pool.query(`ALTER TABLE memories ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
  await pool.query(`ALTER TABLE memories ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
}

export async function initializeCompactionsSchema(pool: pg.Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS compactions (
      id SERIAL PRIMARY KEY,
      summary TEXT NOT NULL,
      up_to_message_id INTEGER NOT NULL REFERENCES messages(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

export interface Memory {
  id: number;
  content: string;
  createdAt: Date;
  updatedAt: Date;
}

export async function loadAllMemories(pool: pg.Pool): Promise<Memory[]> {
  const result = await pool.query("SELECT id, content, created_at, updated_at FROM memories ORDER BY created_at");
  return result.rows.map((row) => ({
    id: row.id as number,
    content: row.content as string,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  }));
}

export async function upsertMemory(pool: pg.Pool, id: number | undefined, content: string): Promise<number> {
  if (id === undefined) {
    const result = await pool.query(
      "INSERT INTO memories (content) VALUES ($1) RETURNING id",
      [content]
    );
    return result.rows[0].id as number;
  } else {
    await pool.query(
      "UPDATE memories SET content = $1, updated_at = NOW() WHERE id = $2",
      [content, id]
    );
    return id;
  }
}

export async function deleteMemory(pool: pg.Pool, id: number): Promise<void> {
  await pool.query("DELETE FROM memories WHERE id = $1", [id]);
}

export interface Compaction {
  id: number;
  summary: string;
  upToMessageId: number;
}

export async function loadLatestCompaction(pool: pg.Pool): Promise<Compaction | null> {
  const result = await pool.query(
    "SELECT id, summary, up_to_message_id FROM compactions ORDER BY id DESC LIMIT 1"
  );
  if (result.rows.length === 0) {
    return null;
  }
  const row = result.rows[0];
  return {
    id: row.id as number,
    summary: row.summary as string,
    upToMessageId: row.up_to_message_id as number,
  };
}

export async function saveCompaction(pool: pg.Pool, summary: string, upToMessageId: number): Promise<void> {
  await pool.query(
    "INSERT INTO compactions (summary, up_to_message_id) VALUES ($1, $2)",
    [summary, upToMessageId]
  );
}

export async function loadMessages(pool: pg.Pool): Promise<AgentMessage[]> {
  const compaction = await loadLatestCompaction(pool);
  
  if (compaction === null) {
    const result = await pool.query("SELECT content FROM messages ORDER BY id");
    return result.rows.map((row) => row.content as AgentMessage);
  }
  
  const result = await pool.query(
    "SELECT content FROM messages WHERE id > $1 ORDER BY id",
    [compaction.upToMessageId]
  );
  let messages = result.rows.map((row) => row.content as AgentMessage);

  // Drop any leading toolResult messages. These can appear when the compaction
  // boundary landed just before a tool-result row that belongs to a tool-use
  // block already included in the summary. Keeping them would produce an
  // orphaned tool_result with no preceding assistant/tool_use, which the API
  // rejects with a 400.
  let firstNonToolResult = 0;
  while (firstNonToolResult < messages.length && messages[firstNonToolResult].role === "toolResult") {
    firstNonToolResult++;
  }
  if (firstNonToolResult > 0) {
    messages = messages.slice(firstNonToolResult);
  }

  const syntheticMessage: AgentMessage = {
    role: "user",
    content: [{ type: "text", text: `[Summary of earlier conversation]\n${compaction.summary}` }],
    timestamp: Date.now(),
  };
  
  return [syntheticMessage, ...messages];
}

export async function saveMessage(pool: pg.Pool, message: AgentMessage): Promise<void> {
  await pool.query(
    "INSERT INTO messages (role, content) VALUES ($1, $2)",
    [message.role, message]
  );
}

export async function initializeCronSchema(pool: pg.Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cron_entries (
      id SERIAL PRIMARY KEY,
      cron_expression TEXT,
      fire_at TIMESTAMPTZ,
      note TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (
        (cron_expression IS NOT NULL AND fire_at IS NULL) OR
        (cron_expression IS NULL AND fire_at IS NOT NULL)
      )
    )
  `);
}

export interface CronEntry {
  id: number;
  cronExpression: string | null;
  fireAt: Date | null;
  note: string;
}

export async function createCronEntry(
  pool: pg.Pool,
  cronExpression: string | null,
  fireAt: Date | null,
  note: string,
): Promise<CronEntry> {
  const result = await pool.query(
    "INSERT INTO cron_entries (cron_expression, fire_at, note) VALUES ($1, $2, $3) RETURNING id, cron_expression, fire_at, note",
    [cronExpression, fireAt, note],
  );
  const row = result.rows[0];
  return {
    id: row.id as number,
    cronExpression: row.cron_expression as string | null,
    fireAt: row.fire_at as Date | null,
    note: row.note as string,
  };
}

export async function updateCronEntry(
  pool: pg.Pool,
  id: number,
  fields: { cronExpression?: string | null; fireAt?: Date | null; note?: string },
): Promise<CronEntry> {
  const setClauses: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  if ("cronExpression" in fields) {
    setClauses.push(`cron_expression = $${paramIndex++}`);
    values.push(fields.cronExpression);
  }
  if ("fireAt" in fields) {
    setClauses.push(`fire_at = $${paramIndex++}`);
    values.push(fields.fireAt);
  }
  if ("note" in fields) {
    setClauses.push(`note = $${paramIndex++}`);
    values.push(fields.note);
  }

  values.push(id);
  const result = await pool.query(
    `UPDATE cron_entries SET ${setClauses.join(", ")} WHERE id = $${paramIndex} RETURNING id, cron_expression, fire_at, note`,
    values,
  );
  const row = result.rows[0];
  return {
    id: row.id as number,
    cronExpression: row.cron_expression as string | null,
    fireAt: row.fire_at as Date | null,
    note: row.note as string,
  };
}

export async function deleteCronEntry(pool: pg.Pool, id: number): Promise<void> {
  await pool.query("DELETE FROM cron_entries WHERE id = $1", [id]);
}

export async function listCronEntries(pool: pg.Pool): Promise<CronEntry[]> {
  const result = await pool.query(
    "SELECT id, cron_expression, fire_at, note FROM cron_entries ORDER BY id",
  );
  return result.rows.map((row) => ({
    id: row.id as number,
    cronExpression: row.cron_expression as string | null,
    fireAt: row.fire_at as Date | null,
    note: row.note as string,
  }));
}

export async function initializePagesSchema(pool: pg.Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pages (
      id SERIAL PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      mimetype TEXT NOT NULL,
      data BYTEA NOT NULL,
      is_public BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE pages ADD COLUMN IF NOT EXISTS queries JSONB`);
}

export interface Page {
  mimetype: string;
  data: Buffer;
  isPublic: boolean;
  queries: Record<string, string> | null;
}

export async function getPageByPath(pool: pg.Pool, path: string): Promise<Page | null> {
  const result = await pool.query(
    "SELECT mimetype, data, is_public, queries FROM pages WHERE path = $1",
    [path],
  );
  if (result.rows.length === 0) {
    return null;
  }
  const row = result.rows[0];
  return {
    mimetype: row.mimetype as string,
    data: row.data as Buffer,
    isPublic: row.is_public as boolean,
    queries: row.queries as Record<string, string> | null,
  };
}

export async function getPageQueryByPath(
  pool: pg.Pool,
  pagePath: string,
  queryName: string,
): Promise<{ query: string; isPublic: boolean } | null> {
  const result = await pool.query(
    "SELECT queries->>$2 AS query, is_public FROM pages WHERE path = $1",
    [pagePath, queryName],
  );
  if (result.rows.length === 0) {
    return null;
  }
  const row = result.rows[0];
  const query = row.query as string | null;
  if (query === null) {
    return null;
  }
  return {
    query,
    isPublic: row.is_public as boolean,
  };
}

export async function upsertPage(
  pool: pg.Pool,
  path: string,
  mimetype?: string,
  content?: string,
  isPublic?: boolean,
  queries?: Record<string, string>,
): Promise<string> {
  const existing = await pool.query("SELECT 1 FROM pages WHERE path = $1", [path]);

  if (existing.rows.length === 0) {
    if (content === undefined || mimetype === undefined) {
      return "Error: content and mimetype are required when creating a new page.";
    }
    await pool.query(
      `INSERT INTO pages (path, mimetype, data, is_public, queries)
       VALUES ($1, $2, convert_to($3, 'UTF8'), $4, $5)`,
      [path, mimetype, content, isPublic ?? false, queries !== undefined ? JSON.stringify(queries) : null],
    );
    return `Page created at /pages/${path}`;
  }

  const setClauses: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  if (mimetype !== undefined) {
    setClauses.push(`mimetype = $${paramIndex++}`);
    values.push(mimetype);
  }
  if (content !== undefined) {
    setClauses.push(`data = convert_to($${paramIndex++}, 'UTF8')`);
    values.push(content);
  }
  if (isPublic !== undefined) {
    setClauses.push(`is_public = $${paramIndex++}`);
    values.push(isPublic);
  }
  if (queries !== undefined) {
    setClauses.push(`queries = $${paramIndex++}`);
    values.push(JSON.stringify(queries));
  }

  if (setClauses.length === 0) {
    return "Error: no fields to update. Provide at least one of mimetype, content, is_public, or queries.";
  }

  setClauses.push(`updated_at = NOW()`);
  values.push(path);

  await pool.query(
    `UPDATE pages SET ${setClauses.join(", ")} WHERE path = $${paramIndex}`,
    values,
  );
  return `Page updated at /pages/${path}`;
}

export async function deletePage(pool: pg.Pool, path: string): Promise<boolean> {
  const result = await pool.query("DELETE FROM pages WHERE path = $1", [path]);
  return (result.rowCount ?? 0) > 0;
}

export async function executeSql(pool: pg.Pool, sql: string): Promise<string> {
  const result = await pool.query(sql);
  
  if (result.command === "SELECT") {
    return JSON.stringify(result.rows);
  } else {
    return JSON.stringify({ rowCount: result.rowCount });
  }
}
