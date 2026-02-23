import { describe, it, expect, vi } from "vitest";
import type { Pool, PoolClient, QueryResult } from "pg";
import { createManageAgentsTool } from "./agents.js";

vi.mock("./database.js", () => ({
  createAgent: vi.fn(),
  updateAgent: vi.fn(),
  listAgents: vi.fn(),
}));

import { createAgent, updateAgent, listAgents } from "./database.js";

const mockCreateAgent = vi.mocked(createAgent);
const mockUpdateAgent = vi.mocked(updateAgent);
const mockListAgents = vi.mocked(listAgents);

function makeText(result: { content: Array<{ type: string; text?: string }> }): string {
  const block = result.content[0];
  if (block.type !== "text" || block.text === undefined) {
    throw new Error("Expected text content block");
  }
  return block.text;
}

function makeMockPool(queryImpl: (text: string, values?: unknown[]) => Promise<QueryResult>): Pool {
  const client = {
    query: vi.fn().mockImplementation(queryImpl),
    release: vi.fn(),
  } as unknown as PoolClient;
  return {
    query: vi.fn().mockImplementation(queryImpl),
    connect: vi.fn().mockResolvedValue(client),
  } as unknown as Pool;
}

describe("manage_agents — help", () => {
  it("returns documentation text containing key terms", async () => {
    const pool = makeMockPool(() => Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult));
    const tool = createManageAgentsTool(pool);
    const result = await tool.execute("call-1", { action: "help" });
    const text = makeText(result);
    expect(text).toContain("create");
    expect(text).toContain("update");
    expect(text).toContain("list");
    expect(text).toContain("allowed_tools");
    expect(text).toContain("send_agent_message");
    expect(text).toContain("execute_sql");
  });
});

describe("manage_agents — create", () => {
  it("returns error when name is missing", async () => {
    const pool = makeMockPool(() => Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult));
    const tool = createManageAgentsTool(pool);
    const result = await tool.execute("call-1", { action: "create", system_prompt: "Do things." });
    expect(makeText(result)).toContain("name is required");
  });

  it("returns error when system_prompt is missing", async () => {
    const pool = makeMockPool(() => Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult));
    const tool = createManageAgentsTool(pool);
    const result = await tool.execute("call-1", { action: "create", name: "helper" });
    expect(makeText(result)).toContain("system_prompt is required");
  });

  it("creates an agent and returns the new ID", async () => {
    mockCreateAgent.mockResolvedValueOnce(5);
    const pool = makeMockPool(() => Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult));
    const tool = createManageAgentsTool(pool);
    const result = await tool.execute("call-1", { action: "create", name: "helper", system_prompt: "Help users.", allowed_tools: ["send_telegram_message"] });
    expect(makeText(result)).toBe("Agent 5 created.");
  });

  it("defaults allowed_tools to [] when not provided", async () => {
    mockCreateAgent.mockResolvedValueOnce(7);
    const pool = makeMockPool(() => Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult));
    const tool = createManageAgentsTool(pool);
    await tool.execute("call-1", { action: "create", name: "helper", system_prompt: "Help users." });
    expect(mockCreateAgent).toHaveBeenCalledWith(pool, "helper", "Help users.", []);
  });
});

describe("manage_agents — update", () => {
  it("returns error when id is missing", async () => {
    const pool = makeMockPool(() => Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult));
    const tool = createManageAgentsTool(pool);
    const result = await tool.execute("call-1", { action: "update", name: "new name" });
    expect(makeText(result)).toContain("id is required");
  });

  it("returns error when trying to update agent 1", async () => {
    const pool = makeMockPool(() => Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult));
    const tool = createManageAgentsTool(pool);
    const result = await tool.execute("call-1", { action: "update", id: 1, name: "hacked" });
    expect(makeText(result)).toContain("Cannot modify agent 1");
  });

  it("returns error when no fields are provided", async () => {
    const pool = makeMockPool(() => Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult));
    const tool = createManageAgentsTool(pool);
    const result = await tool.execute("call-1", { action: "update", id: 3 });
    expect(makeText(result)).toContain("no fields to update");
  });

  it("updates an agent and returns confirmation", async () => {
    mockUpdateAgent.mockResolvedValueOnce(undefined);
    const pool = makeMockPool(() => Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult));
    const tool = createManageAgentsTool(pool);
    const result = await tool.execute("call-1", { action: "update", id: 3, name: "updated name" });
    expect(makeText(result)).toBe("Agent 3 updated.");
  });
});

describe("manage_agents — list", () => {
  it("returns TOON-encoded list of agents", async () => {
    mockListAgents.mockResolvedValueOnce([
      { id: 1, name: "main", systemPrompt: "", allowedTools: ["*"], createdAt: new Date("2024-01-01") },
      { id: 2, name: "helper", systemPrompt: "Help users.", allowedTools: ["send_telegram_message"], createdAt: new Date("2024-02-01") },
    ]);
    const pool = makeMockPool(() => Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult));
    const tool = createManageAgentsTool(pool);
    const result = await tool.execute("call-1", { action: "list" });
    const text = makeText(result);
    expect(text).toContain("main");
    expect(text).toContain("helper");
  });
});
