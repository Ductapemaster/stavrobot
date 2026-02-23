import { describe, it, expect, vi } from "vitest";
import type { Pool, QueryResult } from "pg";
import { createSendSignalMessageTool, createSendTelegramMessageTool } from "./agent.js";
import type { Config } from "./config.js";

// Mock the database module so resolveRecipient and resolveInterlocutorByName can be controlled per test.
vi.mock("./database.js", () => ({
  resolveRecipient: vi.fn(),
  resolveInterlocutorByName: vi.fn(),
}));

import { resolveRecipient, resolveInterlocutorByName } from "./database.js";

function makeText(result: { content: Array<{ type: string; text?: string }> }): string {
  const block = result.content[0];
  if (block.type !== "text" || block.text === undefined) {
    throw new Error("Expected text content block");
  }
  return block.text;
}

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    provider: "anthropic",
    model: "claude-sonnet-4-20250514",
    apiKey: "test-key",
    publicHostname: "https://example.com",
    baseSystemPrompt: "You are a bot.",
    baseAgentPrompt: "You are a bot.",
    owner: { name: "Owner" },
    signal: { account: "+1111111111", allowedNumbers: ["+1234567890"] },
    telegram: { botToken: "test-token", allowedChatIds: [99999] },
    ...overrides,
  } as Config;
}

function makeMockPool(queryImpl: (text: string, values?: unknown[]) => Promise<QueryResult>): Pool {
  return {
    query: vi.fn().mockImplementation(queryImpl),
    connect: vi.fn(),
  } as unknown as Pool;
}

// A pool that returns no rows for any identity check (recipient not in interlocutor_identities).
function makeEmptyPool(): Pool {
  return makeMockPool(() => Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult));
}

// A pool that returns a row for the identity check (recipient exists in interlocutor_identities).
function makeIdentityFoundPool(identifier: string): Pool {
  return makeMockPool(() =>
    Promise.resolve({ rows: [{ identifier }], rowCount: 1 } as unknown as QueryResult),
  );
}

describe("isInAllowlist (via send tools)", () => {
  it("send_signal_message rejects when recipient is not in allowlist", async () => {
    vi.mocked(resolveRecipient).mockResolvedValue(null);
    vi.mocked(resolveInterlocutorByName).mockResolvedValue(null);
    const pool = makeIdentityFoundPool("+9999999999");
    const config = makeConfig({ signal: { account: "+1111111111", allowedNumbers: ["+1234567890"] } });
    const tool = createSendSignalMessageTool(pool, config);
    const result = await tool.execute("call-1", { recipient: "+9999999999", message: "hello" });
    expect(makeText(result)).toContain("not in the Signal allowlist");
  });

  it("send_telegram_message rejects when recipient is not in allowlist", async () => {
    vi.mocked(resolveRecipient).mockResolvedValue(null);
    vi.mocked(resolveInterlocutorByName).mockResolvedValue(null);
    const pool = makeIdentityFoundPool("11111");
    const config = makeConfig({ telegram: { botToken: "tok", allowedChatIds: [99999] } });
    const tool = createSendTelegramMessageTool(pool, config);
    const result = await tool.execute("call-1", { recipient: "11111", message: "hello" });
    expect(makeText(result)).toContain("not in the Telegram allowlist");
  });
});

describe("send_signal_message — recipient resolution", () => {
  it("returns error when no message or attachment is provided", async () => {
    vi.mocked(resolveRecipient).mockResolvedValue(null);
    vi.mocked(resolveInterlocutorByName).mockResolvedValue(null);
    const pool = makeEmptyPool();
    const config = makeConfig();
    const tool = createSendSignalMessageTool(pool, config);
    const result = await tool.execute("call-1", { recipient: "+1234567890" });
    expect(makeText(result)).toContain("at least one of message or attachmentPath must be provided");
  });

  it("rejects with a specific error when interlocutor exists but has no Signal identity", async () => {
    vi.mocked(resolveRecipient).mockResolvedValue(null);
    vi.mocked(resolveInterlocutorByName).mockResolvedValue({ id: 5 });
    const pool = makeEmptyPool();
    const config = makeConfig();
    const tool = createSendSignalMessageTool(pool, config);
    const result = await tool.execute("call-1", { recipient: "Mom", message: "hello" });
    expect(makeText(result)).toContain("has no Signal identity");
    expect(makeText(result)).toContain("manage_interlocutors");
  });

  it("rejects when display name is not found and raw ID is not in interlocutor_identities", async () => {
    vi.mocked(resolveRecipient).mockResolvedValue(null);
    vi.mocked(resolveInterlocutorByName).mockResolvedValue(null);
    const pool = makeEmptyPool();
    const config = makeConfig();
    const tool = createSendSignalMessageTool(pool, config);
    const result = await tool.execute("call-1", { recipient: "Unknown Person", message: "hello" });
    expect(makeText(result)).toContain("unknown recipient");
    expect(makeText(result)).toContain("Unknown Person");
  });

  it("rejects when display name resolves but resolved identifier is not in allowlist", async () => {
    vi.mocked(resolveRecipient).mockResolvedValue({ identifier: "+9999999999" });
    const pool = makeEmptyPool();
    const config = makeConfig({ signal: { account: "+1111111111", allowedNumbers: ["+1234567890"] } });
    const tool = createSendSignalMessageTool(pool, config);
    const result = await tool.execute("call-1", { recipient: "Mom", message: "hello" });
    expect(makeText(result)).toContain("not in the Signal allowlist");
  });

  it("rejects when signal config is missing (no allowlist)", async () => {
    vi.mocked(resolveRecipient).mockResolvedValue({ identifier: "+1234567890" });
    const pool = makeEmptyPool();
    const config = makeConfig({ signal: undefined });
    const tool = createSendSignalMessageTool(pool, config);
    const result = await tool.execute("call-1", { recipient: "Mom", message: "hello" });
    expect(makeText(result)).toContain("not in the Signal allowlist");
  });

  it("rejects with disabled error when resolveRecipient returns disabled", async () => {
    vi.mocked(resolveRecipient).mockResolvedValue({ disabled: true, displayName: "Mom" });
    const pool = makeEmptyPool();
    const config = makeConfig();
    const tool = createSendSignalMessageTool(pool, config);
    const result = await tool.execute("call-1", { recipient: "Mom", message: "hello" });
    expect(makeText(result)).toContain('Interlocutor "Mom" is disabled');
  });
});

describe("send_telegram_message — recipient resolution", () => {
  it("returns error when no message or attachment is provided", async () => {
    vi.mocked(resolveRecipient).mockResolvedValue(null);
    vi.mocked(resolveInterlocutorByName).mockResolvedValue(null);
    const pool = makeEmptyPool();
    const config = makeConfig();
    const tool = createSendTelegramMessageTool(pool, config);
    const result = await tool.execute("call-1", { recipient: "99999" });
    expect(makeText(result)).toContain("at least one of message or attachmentPath must be provided");
  });

  it("rejects with a specific error when interlocutor exists but has no Telegram identity", async () => {
    vi.mocked(resolveRecipient).mockResolvedValue(null);
    vi.mocked(resolveInterlocutorByName).mockResolvedValue({ id: 5 });
    const pool = makeEmptyPool();
    const config = makeConfig();
    const tool = createSendTelegramMessageTool(pool, config);
    const result = await tool.execute("call-1", { recipient: "Mom", message: "hello" });
    expect(makeText(result)).toContain("has no Telegram identity");
    expect(makeText(result)).toContain("manage_interlocutors");
  });

  it("rejects when display name is not found and raw ID is not in interlocutor_identities", async () => {
    vi.mocked(resolveRecipient).mockResolvedValue(null);
    vi.mocked(resolveInterlocutorByName).mockResolvedValue(null);
    const pool = makeEmptyPool();
    const config = makeConfig();
    const tool = createSendTelegramMessageTool(pool, config);
    const result = await tool.execute("call-1", { recipient: "Unknown Person", message: "hello" });
    expect(makeText(result)).toContain("unknown recipient");
    expect(makeText(result)).toContain("Unknown Person");
  });

  it("rejects when display name resolves but resolved identifier is not in allowlist", async () => {
    vi.mocked(resolveRecipient).mockResolvedValue({ identifier: "11111" });
    const pool = makeEmptyPool();
    const config = makeConfig({ telegram: { botToken: "tok", allowedChatIds: [99999] } });
    const tool = createSendTelegramMessageTool(pool, config);
    const result = await tool.execute("call-1", { recipient: "Mom", message: "hello" });
    expect(makeText(result)).toContain("not in the Telegram allowlist");
  });

  it("rejects when telegram config is missing", async () => {
    vi.mocked(resolveRecipient).mockResolvedValue(null);
    vi.mocked(resolveInterlocutorByName).mockResolvedValue(null);
    const pool = makeEmptyPool();
    const config = makeConfig({ telegram: undefined });
    const tool = createSendTelegramMessageTool(pool, config);
    const result = await tool.execute("call-1", { recipient: "99999", message: "hello" });
    expect(makeText(result)).toContain("Telegram is not configured");
  });

  it("rejects with disabled error when resolveRecipient returns disabled", async () => {
    vi.mocked(resolveRecipient).mockResolvedValue({ disabled: true, displayName: "Mom" });
    const pool = makeEmptyPool();
    const config = makeConfig();
    const tool = createSendTelegramMessageTool(pool, config);
    const result = await tool.execute("call-1", { recipient: "Mom", message: "hello" });
    expect(makeText(result)).toContain('Interlocutor "Mom" is disabled');
  });
});
