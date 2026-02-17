import { Type } from "@mariozechner/pi-ai";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";

const CODER_BASE_URL = "http://coder:3001";

export function createListToolsTool(): AgentTool {
  return {
    name: "list_tools",
    label: "List tools",
    description: "List all available custom tools. Returns a list of tool names and descriptions. Use this to discover what tools are available before calling them.",
    parameters: Type.Object({}),
    execute: async (
      toolCallId: string,
      params: unknown,
    ): Promise<AgentToolResult<{ result: string }>> => {
      console.log("[stavrobot] list_tools called");
      const response = await fetch(`${CODER_BASE_URL}/tools`);
      const result = await response.text();
      console.log("[stavrobot] list_tools result:", result.length, "characters");
      return {
        content: [{ type: "text" as const, text: result }],
        details: { result },
      };
    },
  };
}

export function createShowToolTool(): AgentTool {
  return {
    name: "show_tool",
    label: "Show tool",
    description: "Show the full manifest for a custom tool, including its parameters and their types. Use this to understand how to call a tool before running it.",
    parameters: Type.Object({
      name: Type.String({ description: "The name of the tool to inspect." }),
    }),
    execute: async (
      toolCallId: string,
      params: unknown,
    ): Promise<AgentToolResult<{ result: string }>> => {
      const { name } = params as { name: string };
      console.log("[stavrobot] show_tool called:", name);
      const response = await fetch(`${CODER_BASE_URL}/tools/${name}`);
      if (response.status === 404) {
        const result = `Tool '${name}' not found.`;
        return {
          content: [{ type: "text" as const, text: result }],
          details: { result },
        };
      }
      const result = await response.text();
      console.log("[stavrobot] show_tool result:", result.length, "characters");
      return {
        content: [{ type: "text" as const, text: result }],
        details: { result },
      };
    },
  };
}

export function createRunToolTool(): AgentTool {
  return {
    name: "run_tool",
    label: "Run tool",
    description: "Run a custom tool with the given parameters. The parameters must match the tool's manifest schema.",
    parameters: Type.Object({
      name: Type.String({ description: "The name of the tool to run." }),
      parameters: Type.String({ description: "JSON string of the parameters to pass to the tool." }),
    }),
    execute: async (
      toolCallId: string,
      params: unknown,
    ): Promise<AgentToolResult<{ result: string }>> => {
      const { name, parameters } = params as { name: string; parameters: string };
      console.log("[stavrobot] run_tool called:", name, "parameters:", parameters);
      const parsedParameters = JSON.parse(parameters) as unknown;
      const response = await fetch(`${CODER_BASE_URL}/tools/${name}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsedParameters),
      });
      const result = await response.text();
      console.log("[stavrobot] run_tool result:", result.length, "characters");
      return {
        content: [{ type: "text" as const, text: result }],
        details: { result },
      };
    },
  };
}

export function createRequestCodingTaskTool(): AgentTool {
  return {
    name: "request_coding_task",
    label: "Request coding task",
    description: "Request the coding agent to create or modify a custom tool. This is asynchronous — the result will arrive later as a message from the coder agent. Describe what you want the tool to do clearly and completely.",
    parameters: Type.Object({
      message: Type.String({ description: "A detailed description of what tool to create or modify." }),
    }),
    execute: async (
      toolCallId: string,
      params: unknown,
    ): Promise<AgentToolResult<{ result: string }>> => {
      const { message } = params as { message: string };
      const taskId = crypto.randomUUID();
      console.log("[stavrobot] request_coding_task called: taskId", taskId, "message:", message);
      await fetch(`${CODER_BASE_URL}/code`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId, message }),
      });
      const result = `Coding task ${taskId} submitted. The coder agent will respond when done.`;
      console.log("[stavrobot] request_coding_task submitted:", taskId);
      return {
        content: [{ type: "text" as const, text: result }],
        details: { result },
      };
    },
  };
}
