import { describe, it, expect, vi, afterEach } from "vitest";
import { createRunPluginToolTool, createManagePluginsTool, createRequestCodingTaskTool } from "./plugin-tools.js";

function mockFetch(status: number, body: string): void {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    status,
    text: () => Promise.resolve(body),
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createRunPluginToolTool", () => {
  const tool = createRunPluginToolTool();

  it("formats a successful sync result with string output", async () => {
    mockFetch(200, JSON.stringify({ success: true, output: "hello world" }));
    const result = await tool.execute("call-1", { plugin: "myplugin", tool: "mytool", parameters: "{}" });
    expect(result.content[0].type).toBe("text");
    const text = (result.content[0] as { type: string; text: string }).text;
    expect(text).toBe('The run of tool "mytool" (plugin "myplugin") returned:\n```\nhello world\n```');
  });

  it("formats a successful sync result with object output as JSON", async () => {
    mockFetch(200, JSON.stringify({ success: true, output: { key: "value" } }));
    const result = await tool.execute("call-2", { plugin: "myplugin", tool: "mytool", parameters: "{}" });
    const text = (result.content[0] as { type: string; text: string }).text;
    expect(text).toBe('The run of tool "mytool" (plugin "myplugin") returned:\n```\n{"key":"value"}\n```');
  });

  it("formats a failed sync result with error message", async () => {
    mockFetch(200, JSON.stringify({ success: false, error: "something went wrong" }));
    const result = await tool.execute("call-3", { plugin: "myplugin", tool: "mytool", parameters: "{}" });
    const text = (result.content[0] as { type: string; text: string }).text;
    expect(text).toBe('The run of tool "mytool" (plugin "myplugin") failed:\n```\nsomething went wrong\n```');
  });

  it("uses 'Unknown error' when failure has no error field", async () => {
    mockFetch(200, JSON.stringify({ success: false }));
    const result = await tool.execute("call-4", { plugin: "myplugin", tool: "mytool", parameters: "{}" });
    const text = (result.content[0] as { type: string; text: string }).text;
    expect(text).toBe('The run of tool "mytool" (plugin "myplugin") failed:\n```\nUnknown error\n```');
  });

  it("returns async message for 202 response", async () => {
    mockFetch(202, JSON.stringify({ status: "running" }));
    const result = await tool.execute("call-5", { plugin: "myplugin", tool: "mytool", parameters: "{}" });
    const text = (result.content[0] as { type: string; text: string }).text;
    expect(text).toBe('Tool "mytool" (plugin "myplugin") is running asynchronously. The result will arrive when it completes.');
  });

  it("falls back to raw text when response is not valid JSON", async () => {
    mockFetch(200, "not json at all");
    const result = await tool.execute("call-6", { plugin: "myplugin", tool: "mytool", parameters: "{}" });
    const text = (result.content[0] as { type: string; text: string }).text;
    expect(text).toBe("not json at all");
  });

  it("falls back to raw text when JSON does not have a 'success' boolean", async () => {
    mockFetch(200, JSON.stringify({ result: "something" }));
    const result = await tool.execute("call-7", { plugin: "myplugin", tool: "mytool", parameters: "{}" });
    const text = (result.content[0] as { type: string; text: string }).text;
    expect(text).toBe(JSON.stringify({ result: "something" }));
  });
});

describe("createManagePluginsTool", () => {
  describe("help action", () => {
    const tool = createManagePluginsTool({ coderEnabled: false });

    it("returns help text", async () => {
      const result = await tool.execute("call-1", { action: "help" });
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toContain("manage_plugins");
      expect(text).toContain("install");
      expect(text).toContain("create");
    });
  });

  describe("install action", () => {
    const tool = createManagePluginsTool({ coderEnabled: false });

    it("returns the message field from the response JSON", async () => {
      mockFetch(200, JSON.stringify({ name: "myplugin", message: "Plugin 'myplugin' installed successfully." }));
      const result = await tool.execute("call-1", { action: "install", url: "https://example.com/plugin.git" });
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toBe("Plugin 'myplugin' installed successfully.");
    });

    it("appends init_output when present", async () => {
      mockFetch(200, JSON.stringify({
        name: "myplugin",
        message: "Plugin 'myplugin' installed successfully.",
        init_output: "Installed dependencies.\n",
      }));
      const result = await tool.execute("call-2", { action: "install", url: "https://example.com/plugin.git" });
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toBe("Plugin 'myplugin' installed successfully.\n\nInit script output:\n```\nInstalled dependencies.\n\n```");
    });

    it("falls back to raw text when response is not valid JSON", async () => {
      mockFetch(200, "not json");
      const result = await tool.execute("call-3", { action: "install", url: "https://example.com/plugin.git" });
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toBe("not json");
    });

    it("falls back to raw text when JSON has no message field", async () => {
      const raw = JSON.stringify({ name: "myplugin" });
      mockFetch(200, raw);
      const result = await tool.execute("call-4", { action: "install", url: "https://example.com/plugin.git" });
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toBe(raw);
    });

    it("returns an error when url is missing", async () => {
      const result = await tool.execute("call-5", { action: "install" });
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toBe("Error: url is required for install.");
    });
  });

  describe("update action", () => {
    const tool = createManagePluginsTool({ coderEnabled: false });

    it("returns the message field from the response JSON", async () => {
      mockFetch(200, JSON.stringify({ name: "myplugin", message: "Plugin 'myplugin' updated successfully." }));
      const result = await tool.execute("call-1", { action: "update", name: "myplugin" });
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toBe("Plugin 'myplugin' updated successfully.");
    });

    it("appends init_output when present", async () => {
      mockFetch(200, JSON.stringify({
        name: "myplugin",
        message: "Plugin 'myplugin' updated successfully.",
        init_output: "Re-installed dependencies.\n",
      }));
      const result = await tool.execute("call-2", { action: "update", name: "myplugin" });
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toBe("Plugin 'myplugin' updated successfully.\n\nInit script output:\n```\nRe-installed dependencies.\n\n```");
    });

    it("returns an error when name is missing", async () => {
      const result = await tool.execute("call-3", { action: "update" });
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toBe("Error: name is required for update.");
    });
  });

  describe("create action", () => {
    it("calls POST /create with the correct body and returns the response text when coder is enabled", async () => {
      const tool = createManagePluginsTool({ coderEnabled: true });
      const responseBody = JSON.stringify({ name: "myplugin", message: "Plugin 'myplugin' created." });
      mockFetch(200, responseBody);
      const result = await tool.execute("call-1", { action: "create", name: "myplugin", plugin_description: "A test plugin." });
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toBe(responseBody);
      const fetchMock = vi.mocked(globalThis.fetch);
      expect(fetchMock).toHaveBeenCalledWith(
        "http://plugin-runner:3003/create",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ name: "myplugin", description: "A test plugin." }),
        }),
      );
    });

    it("returns an error when coder is not enabled", async () => {
      const tool = createManagePluginsTool({ coderEnabled: false });
      const result = await tool.execute("call-2", { action: "create", name: "myplugin", plugin_description: "A test plugin." });
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toBe("Error: the create action requires the coder to be configured.");
    });

    it("returns an error when name is missing", async () => {
      const tool = createManagePluginsTool({ coderEnabled: true });
      const result = await tool.execute("call-3", { action: "create", plugin_description: "A test plugin." });
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toBe("Error: name is required for create.");
    });

    it("returns an error when plugin_description is missing", async () => {
      const tool = createManagePluginsTool({ coderEnabled: true });
      const result = await tool.execute("call-4", { action: "create", name: "myplugin" });
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toBe("Error: plugin_description is required for create.");
    });
  });
});

describe("createRequestCodingTaskTool", () => {
  const tool = createRequestCodingTaskTool();

  it("returns an error when the plugin is not found (404)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({
      status: 404,
      text: () => Promise.resolve("Not found"),
    }));
    const result = await tool.execute("call-1", { plugin: "missing", message: "Add a tool." });
    const text = (result.content[0] as { type: string; text: string }).text;
    expect(text).toBe("Plugin 'missing' not found. Create it first with manage_plugins (action: create).");
  });

  it("returns an error when the plugin is not editable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({
      status: 200,
      text: () => Promise.resolve(JSON.stringify({ name: "gitplugin", editable: false })),
    }));
    const result = await tool.execute("call-2", { plugin: "gitplugin", message: "Add a tool." });
    const text = (result.content[0] as { type: string; text: string }).text;
    expect(text).toBe("Plugin 'gitplugin' is not editable. Only locally created plugins can be modified by the coding agent.");
  });

  it("submits the task to the coder when the plugin is editable", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ name: "myplugin", editable: true })),
      })
      .mockResolvedValueOnce({
        status: 202,
        text: () => Promise.resolve(""),
      }),
    );
    const result = await tool.execute("call-3", { plugin: "myplugin", message: "Add a hello tool." });
    const text = (result.content[0] as { type: string; text: string }).text;
    expect(text).toMatch(/^Coding task .+ submitted for plugin 'myplugin'\. The coder agent will respond when done\.$/);
    const fetchMock = vi.mocked(globalThis.fetch);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://plugin-runner:3003/bundles/myplugin",
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://coder:3002/code",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"plugin":"myplugin"'),
      }),
    );
  });
});
