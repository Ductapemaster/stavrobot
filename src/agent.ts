import pg from "pg";
import { Type, getModel, type TextContent, complete, type AssistantMessage } from "@mariozechner/pi-ai";
import { Agent, type AgentTool, type AgentToolResult, type AgentMessage } from "@mariozechner/pi-agent-core";
import type { Config } from "./config.js";
import { executeSql, loadMessages, saveMessage, saveCompaction, loadLatestCompaction, loadAllMemories, upsertMemory, deleteMemory, type Memory } from "./database.js";

export function createExecuteSqlTool(pool: pg.Pool): AgentTool {
  return {
    name: "execute_sql",
    label: "Execute SQL",
    description: "Execute arbitrary SQL queries against the PostgreSQL database. Supports all SQL operations including CREATE TABLE, INSERT, UPDATE, DELETE, SELECT, ALTER TABLE, DROP TABLE, and more. Use this to store and retrieve any information in the database.",
    parameters: Type.Object({
      query: Type.String({ description: "The SQL query to execute" }),
    }),
    execute: async (
      toolCallId: string,
      params: unknown
    ): Promise<AgentToolResult<{ result: string }>> => {
      const { query } = params as { query: string };
      const result = await executeSql(pool, query);
      return {
        content: [{ type: "text" as const, text: result }],
        details: { result },
      };
    },
  };
}

export function createUpdateMemoryTool(pool: pg.Pool): AgentTool {
  return {
    name: "update_memory",
    label: "Update memory",
    description: "Create or update a persistent memory. To create a new memory, omit the id. To update an existing memory, provide its id. Memories persist across sessions and are shown to you at the start of every conversation.",
    parameters: Type.Object({
      id: Type.Optional(Type.Number({ description: "The id of the memory to update. Omit to create a new memory." })),
      content: Type.String({ description: "The content of the memory." }),
    }),
    execute: async (
      toolCallId: string,
      params: unknown
    ): Promise<AgentToolResult<{ message: string }>> => {
      const { id, content } = params as { id?: number; content: string };
      const memoryId = await upsertMemory(pool, id, content);
      const message = id === undefined ? `Memory ${memoryId} created.` : `Memory ${memoryId} updated.`;
      return {
        content: [{ type: "text" as const, text: message }],
        details: { message },
      };
    },
  };
}

export function createDeleteMemoryTool(pool: pg.Pool): AgentTool {
  return {
    name: "delete_memory",
    label: "Delete memory",
    description: "Delete a persistent memory by its id.",
    parameters: Type.Object({
      id: Type.Number({ description: "The id of the memory to delete." }),
    }),
    execute: async (
      toolCallId: string,
      params: unknown
    ): Promise<AgentToolResult<{ message: string }>> => {
      const { id } = params as { id: number };
      await deleteMemory(pool, id);
      const message = `Memory ${id} deleted.`;
      return {
        content: [{ type: "text" as const, text: message }],
        details: { message },
      };
    },
  };
}

export async function createAgent(config: Config, pool: pg.Pool): Promise<Agent> {
  const model = getModel(config.provider as any, config.model as any);
  const messages = await loadMessages(pool);
  const tools = [createExecuteSqlTool(pool), createUpdateMemoryTool(pool), createDeleteMemoryTool(pool)];

  const agent = new Agent({
    initialState: {
      systemPrompt: config.systemPrompt,
      model,
      tools,
      messages,
    },
    getApiKey: () => config.apiKey,
  });

  return agent;
}

function serializeMessagesForSummary(messages: AgentMessage[]): string {
  const lines: string[] = [];
  
  for (const message of messages) {
    if (message.role === "user") {
      let textContent: string;
      if (typeof message.content === "string") {
        textContent = message.content;
      } else {
        const content = Array.isArray(message.content) ? message.content : [];
        textContent = content
          .filter((block): block is TextContent => block.type === "text")
          .map((block) => block.text)
          .join("");
      }
      lines.push(`User: ${textContent}`);
    } else if (message.role === "assistant") {
      const content = Array.isArray(message.content) ? message.content : [];
      const textContent = content
        .filter((block): block is TextContent => block.type === "text")
        .map((block) => block.text)
        .join("");
      if (textContent) {
        lines.push(`Assistant: ${textContent}`);
      }
    } else if (message.role === "toolResult") {
      const content = Array.isArray(message.content) ? message.content : [];
      const textContent = content
        .filter((block): block is TextContent => block.type === "text")
        .map((block) => block.text)
        .join("");
      lines.push(`Tool result (${message.toolName}): ${textContent}`);
    }
  }
  
  return lines.join("\n");
}

export async function handlePrompt(
  agent: Agent,
  pool: pg.Pool,
  userMessage: string,
  config: Config
): Promise<string> {
  const memories = await loadAllMemories(pool);
  
  if (memories.length === 0) {
    agent.setSystemPrompt(config.systemPrompt);
  } else {
    const memoryLines: string[] = [
      "These are your memories, they are things you stored yourself. Use the `update_memory` tool to update a memory, and the `delete_memory` tool to delete a memory. You should add anything that seems important to the user, anything that might have bearing on the future, or anything that will be important to recall later. However, do keep them to a few paragraphs, to avoid filling up the context.",
      "",
      "Here are your memories:",
      "",
    ];
    
    for (const memory of memories) {
      memoryLines.push(`[Memory ${memory.id}]`);
      memoryLines.push(memory.content);
      memoryLines.push("");
    }
    
    const injectionText = memoryLines.join("\n");
    agent.setSystemPrompt(`${config.systemPrompt}\n\n${injectionText}`);
  }

  const savePromises: Promise<void>[] = [];

  const unsubscribe = agent.subscribe((event) => {
    if (event.type === "message_end") {
      const message = event.message;
      if (
        message.role === "user" ||
        message.role === "assistant" ||
        message.role === "toolResult"
      ) {
        savePromises.push(saveMessage(pool, message));
      }
    }
  });

  try {
    await agent.prompt(userMessage);
  } finally {
    unsubscribe();
    await Promise.all(savePromises);
  }

  if (agent.state.messages.length > 40) {
    const currentMessages = agent.state.messages;
    const messagesToCompact = currentMessages.slice(0, -20);
    const messagesToKeep = currentMessages.slice(-20);

    const serializedMessages = serializeMessagesForSummary(messagesToCompact);
    const summarySystemPrompt = "Summarize the following conversation concisely. Preserve all important facts, decisions, user preferences, and context. The summary will replace these messages in the conversation history.";
    
    const response = await complete(
      agent.state.model,
      {
        systemPrompt: summarySystemPrompt,
        messages: [
          {
            role: "user" as const,
            content: serializedMessages,
            timestamp: Date.now(),
          },
        ],
      },
      { apiKey: config.apiKey }
    );

    const summaryText = response.content
      .filter((block): block is TextContent => block.type === "text")
      .map((block) => block.text)
      .join("");

    const previousCompaction = await loadLatestCompaction(pool);
    const previousBoundary = previousCompaction ? previousCompaction.upToMessageId : 0;
    
    const cutoffResult = await pool.query(
      "SELECT id FROM messages WHERE id > $1 ORDER BY id DESC LIMIT 1 OFFSET 19",
      [previousBoundary]
    );
    const upToMessageId = cutoffResult.rows[0].id as number;

    await saveCompaction(pool, summaryText, upToMessageId);

    const syntheticMessage: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: summaryText }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "synthetic-compaction",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };

    const newMessages = [syntheticMessage, ...messagesToKeep];
    agent.replaceMessages(newMessages);
  }

  const lastAssistantMessage = agent.state.messages
    .slice()
    .reverse()
    .find((message) => message.role === "assistant");

  if (!lastAssistantMessage) {
    return "";
  }

  const responseText = lastAssistantMessage.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("");

  return responseText;
}
