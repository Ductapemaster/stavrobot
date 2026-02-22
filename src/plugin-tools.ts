import { Type } from "@mariozechner/pi-ai";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";

const PLUGIN_RUNNER_BASE_URL = "http://plugin-runner:3003";
const CLAUDE_CODE_BASE_URL = "http://coder:3002";

interface BundleManifest {
  editable?: boolean;
  [key: string]: unknown;
}

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

export function createCreatePluginTool(): AgentTool {
  return {
    name: "create_plugin",
    label: "Create plugin",
    description: "Create a new empty plugin with the given name and description. The plugin will be locally editable and can be populated with tools by the coding agent via request_coding_task.",
    parameters: Type.Object({
      name: Type.String({ description: "The plugin name (used as the directory name and identifier)." }),
      description: Type.String({ description: "A short description of what the plugin does." }),
    }),
    execute: async (
      toolCallId: string,
      params: unknown,
    ): Promise<AgentToolResult<{ result: string }>> => {
      const { name, description } = params as { name: string; description: string };
      console.log("[stavrobot] create_plugin called: name:", name);
      const response = await fetch(`${PLUGIN_RUNNER_BASE_URL}/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, description }),
      });
      const result = await response.text();
      console.log("[stavrobot] create_plugin result:", result.length, "characters");
      return {
        content: [{ type: "text" as const, text: result }],
        details: { result },
      };
    },
  };
}

function isBundleManifest(value: unknown): value is BundleManifest {
  return typeof value === "object" && value !== null;
}

export function createRequestCodingTaskTool(): AgentTool {
  return {
    name: "request_coding_task",
    label: "Request coding task",
    description: "Send a coding task to the coding agent to create or modify a specific plugin. The plugin must be editable (locally created, not installed from a git repository). This is asynchronous — the result will arrive later as a message from the coder agent. Describe what you want clearly and completely.",
    parameters: Type.Object({
      plugin: Type.String({ description: "The name of the plugin to create or modify. Must be an editable (locally created) plugin." }),
      message: Type.String({ description: "A detailed description of what to create or modify in the plugin." }),
    }),
    execute: async (
      toolCallId: string,
      params: unknown,
    ): Promise<AgentToolResult<{ result: string }>> => {
      const { plugin, message } = params as { plugin: string; message: string };
      console.log("[stavrobot] request_coding_task called: plugin:", plugin);

      const bundleResponse = await fetch(`${PLUGIN_RUNNER_BASE_URL}/bundles/${plugin}`);
      if (bundleResponse.status === 404) {
        const result = `Plugin '${plugin}' not found. Create it first with create_plugin.`;
        return {
          content: [{ type: "text" as const, text: result }],
          details: { result },
        };
      }

      const bundleText = await bundleResponse.text();
      let manifest: unknown;
      try {
        manifest = JSON.parse(bundleText) as unknown;
      } catch {
        const result = `Failed to parse plugin manifest for '${plugin}'.`;
        return {
          content: [{ type: "text" as const, text: result }],
          details: { result },
        };
      }

      if (!isBundleManifest(manifest) || manifest.editable !== true) {
        const result = `Plugin '${plugin}' is not editable. Only locally created plugins can be modified by the coding agent.`;
        return {
          content: [{ type: "text" as const, text: result }],
          details: { result },
        };
      }

      const taskId = crypto.randomUUID();
      console.log("[stavrobot] request_coding_task submitting: taskId", taskId, "plugin:", plugin, "message:", message);
      await fetch(`${CLAUDE_CODE_BASE_URL}/code`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId, plugin, message }),
      });
      const result = `Coding task ${taskId} submitted for plugin '${plugin}'. The coder agent will respond when done.`;
      console.log("[stavrobot] request_coding_task submitted:", taskId);
      return {
        content: [{ type: "text" as const, text: result }],
        details: { result },
      };
    },
  };
}
