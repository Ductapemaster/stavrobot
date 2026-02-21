import { Type } from "@mariozechner/pi-ai";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";

const PLUGIN_RUNNER_BASE_URL = "http://plugin-runner:3003";

interface PluginRunResult {
  success: boolean;
  output?: unknown;
  error?: string;
}

interface PluginInitResponse {
  init_output?: string;
  [key: string]: unknown;
}

function isPluginRunResult(value: unknown): value is PluginRunResult {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return typeof obj["success"] === "boolean";
}

function isPluginInitResponse(value: unknown): value is PluginInitResponse {
  return typeof value === "object" && value !== null;
}

function formatRunPluginToolResult(pluginName: string, toolName: string, responseText: string, statusCode: number): string {
  if (statusCode === 202) {
    return `Tool "${toolName}" (plugin "${pluginName}") is running asynchronously. The result will arrive when it completes.`;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText) as unknown;
  } catch {
    return responseText;
  }

  if (!isPluginRunResult(parsed)) {
    return responseText;
  }

  if (parsed.success) {
    const output = typeof parsed.output === "string" ? parsed.output : JSON.stringify(parsed.output);
    return `The run of tool "${toolName}" (plugin "${pluginName}") returned:\n\`\`\`\n${output}\n\`\`\``;
  } else {
    const error = parsed.error ?? "Unknown error";
    return `The run of tool "${toolName}" (plugin "${pluginName}") failed:\n\`\`\`\n${error}\n\`\`\``;
  }
}

// Parse the install/update response JSON and return a human-readable string.
// The plugin-runner always includes a "message" field; if "init_output" is also
// present, it is appended in a fenced code block so the LLM can see the output.
function formatInitResponse(responseText: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText) as unknown;
  } catch {
    return responseText;
  }

  if (!isPluginInitResponse(parsed)) {
    return responseText;
  }

  const message = typeof parsed["message"] === "string" ? parsed["message"] : responseText;

  if (typeof parsed.init_output === "string") {
    return `${message}\n\nInit script output:\n\`\`\`\n${parsed.init_output}\n\`\`\``;
  }

  return message;
}

export function createInstallPluginTool(): AgentTool {
  return {
    name: "install_plugin",
    label: "Install plugin",
    description: "Install a plugin from a git repository URL. Returns the plugin manifest and any configuration requirements.",
    parameters: Type.Object({
      url: Type.String({ description: "The git repository URL to clone." }),
    }),
    execute: async (
      toolCallId: string,
      params: unknown,
    ): Promise<AgentToolResult<{ result: string }>> => {
      const { url } = params as { url: string };
      console.log("[stavrobot] install_plugin called:", url);
      const response = await fetch(`${PLUGIN_RUNNER_BASE_URL}/install`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const responseText = await response.text();
      console.log("[stavrobot] install_plugin result:", responseText.length, "characters");
      const result = formatInitResponse(responseText);
      return {
        content: [{ type: "text" as const, text: result }],
        details: { result },
      };
    },
  };
}

export function createUpdatePluginTool(): AgentTool {
  return {
    name: "update_plugin",
    label: "Update plugin",
    description: "Update an installed plugin to the latest version from its git repository.",
    parameters: Type.Object({
      name: Type.String({ description: "The plugin name." }),
    }),
    execute: async (
      toolCallId: string,
      params: unknown,
    ): Promise<AgentToolResult<{ result: string }>> => {
      const { name } = params as { name: string };
      console.log("[stavrobot] update_plugin called:", name);
      const response = await fetch(`${PLUGIN_RUNNER_BASE_URL}/update`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const responseText = await response.text();
      console.log("[stavrobot] update_plugin result:", responseText.length, "characters");
      const result = formatInitResponse(responseText);
      return {
        content: [{ type: "text" as const, text: result }],
        details: { result },
      };
    },
  };
}

export function createRemovePluginTool(): AgentTool {
  return {
    name: "remove_plugin",
    label: "Remove plugin",
    description: "Remove an installed plugin.",
    parameters: Type.Object({
      name: Type.String({ description: "The plugin name." }),
    }),
    execute: async (
      toolCallId: string,
      params: unknown,
    ): Promise<AgentToolResult<{ result: string }>> => {
      const { name } = params as { name: string };
      console.log("[stavrobot] remove_plugin called:", name);
      const response = await fetch(`${PLUGIN_RUNNER_BASE_URL}/remove`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const result = await response.text();
      console.log("[stavrobot] remove_plugin result:", result.length, "characters");
      return {
        content: [{ type: "text" as const, text: result }],
        details: { result },
      };
    },
  };
}

export function createConfigurePluginTool(): AgentTool {
  return {
    name: "configure_plugin",
    label: "Configure plugin",
    description: "Set configuration values for a plugin. The config keys must match what the plugin's manifest declares. Pass the config as a JSON string.",
    parameters: Type.Object({
      name: Type.String({ description: "The plugin name." }),
      config: Type.String({ description: "JSON string of configuration values to set." }),
    }),
    execute: async (
      toolCallId: string,
      params: unknown,
    ): Promise<AgentToolResult<{ result: string }>> => {
      const { name, config } = params as { name: string; config: string };
      console.log("[stavrobot] configure_plugin called: name:", name, "config:", config);
      let parsedConfig: unknown;
      try {
        parsedConfig = JSON.parse(config);
      } catch {
        const result = "Error: config is not valid JSON.";
        return {
          content: [{ type: "text" as const, text: result }],
          details: { result },
        };
      }
      const response = await fetch(`${PLUGIN_RUNNER_BASE_URL}/configure`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, config: parsedConfig }),
      });
      const result = await response.text();
      console.log("[stavrobot] configure_plugin result:", result.length, "characters");
      return {
        content: [{ type: "text" as const, text: result }],
        details: { result },
      };
    },
  };
}

export function createListPluginsTool(): AgentTool {
  return {
    name: "list_plugins",
    label: "List plugins",
    description: "List all installed plugins. Returns plugin names and descriptions.",
    parameters: Type.Object({}),
    execute: async (
      toolCallId: string,
      params: unknown,
    ): Promise<AgentToolResult<{ result: string }>> => {
      console.log("[stavrobot] list_plugins called");
      const response = await fetch(`${PLUGIN_RUNNER_BASE_URL}/bundles`);
      const result = await response.text();
      console.log("[stavrobot] list_plugins result:", result.length, "characters");
      return {
        content: [{ type: "text" as const, text: result }],
        details: { result },
      };
    },
  };
}

export function createShowPluginTool(): AgentTool {
  return {
    name: "show_plugin",
    label: "Show plugin",
    description: "Show all tools in a plugin, including their names, descriptions, and parameter schemas.",
    parameters: Type.Object({
      name: Type.String({ description: "The plugin name." }),
    }),
    execute: async (
      toolCallId: string,
      params: unknown,
    ): Promise<AgentToolResult<{ result: string }>> => {
      const { name } = params as { name: string };
      console.log("[stavrobot] show_plugin called:", name);
      const response = await fetch(`${PLUGIN_RUNNER_BASE_URL}/bundles/${name}`);
      if (response.status === 404) {
        const result = `Plugin '${name}' not found.`;
        return {
          content: [{ type: "text" as const, text: result }],
          details: { result },
        };
      }
      const result = await response.text();
      console.log("[stavrobot] show_plugin result:", result.length, "characters");
      return {
        content: [{ type: "text" as const, text: result }],
        details: { result },
      };
    },
  };
}

export function createRunPluginToolTool(): AgentTool {
  return {
    name: "run_plugin_tool",
    label: "Run plugin tool",
    description: "Run a tool from an installed plugin with the given parameters. The parameters must match the tool's schema as shown by show_plugin.",
    parameters: Type.Object({
      plugin: Type.String({ description: "The plugin name." }),
      tool: Type.String({ description: "The tool name." }),
      parameters: Type.String({ description: "JSON string of the parameters to pass to the tool." }),
    }),
    execute: async (
      toolCallId: string,
      params: unknown,
    ): Promise<AgentToolResult<{ result: string }>> => {
      const { plugin, tool, parameters } = params as { plugin: string; tool: string; parameters: string };
      console.log("[stavrobot] run_plugin_tool called: plugin:", plugin, "tool:", tool, "parameters:", parameters);
      const parsedParameters = JSON.parse(parameters) as unknown;
      const response = await fetch(`${PLUGIN_RUNNER_BASE_URL}/bundles/${plugin}/tools/${tool}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsedParameters),
      });
      const responseText = await response.text();
      console.log("[stavrobot] run_plugin_tool result:", responseText.length, "characters");
      const result = formatRunPluginToolResult(plugin, tool, responseText, response.status);
      return {
        content: [{ type: "text" as const, text: result }],
        details: { result },
      };
    },
  };
}
