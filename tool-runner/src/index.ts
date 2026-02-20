import http from "http";
import fs from "fs";
import path from "path";
import { execSync, spawn } from "child_process";

const TOOLS_DIR = "/tools";
const TOOL_TIMEOUT_MS = 30_000;

let toolRunnerUid: number | undefined;
let toolRunnerGid: number | undefined;

function getToolRunnerIds(): { uid: number; gid: number } {
  if (toolRunnerUid === undefined || toolRunnerGid === undefined) {
    try {
      toolRunnerUid = parseInt(execSync("id -u toolrunner").toString().trim(), 10);
      toolRunnerGid = parseInt(execSync("id -g toolrunner").toString().trim(), 10);
    } catch {
      throw new Error("toolrunner user not found — requires the Docker container environment");
    }
  }
  return { uid: toolRunnerUid, gid: toolRunnerGid };
}

interface ToolManifest {
  name: string;
  description: string;
  entrypoint: string;
  [key: string]: unknown;
}

async function readRequestBody(request: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

function readManifest(toolName: string): ToolManifest | null {
  const manifestPath = path.join(TOOLS_DIR, toolName, "manifest.json");
  try {
    const content = fs.readFileSync(manifestPath, "utf-8");
    return JSON.parse(content) as ToolManifest;
  } catch {
    return null;
  }
}

function handleListTools(response: http.ServerResponse): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(TOOLS_DIR);
  } catch {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ tools: [] }));
    return;
  }

  const tools: { name: string; description: string }[] = [];
  for (const entry of entries) {
    const manifest = readManifest(entry);
    if (manifest === null) {
      console.warn(`[stavrobot-tool-runner] Skipping ${entry}: missing or invalid manifest.json`);
      continue;
    }
    tools.push({ name: manifest.name, description: manifest.description });
  }

  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ tools }));
}

function handleGetTool(toolName: string, response: http.ServerResponse): void {
  const manifest = readManifest(toolName);
  if (manifest === null) {
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "Tool not found" }));
    return;
  }

  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify(manifest));
}

async function handleRunTool(
  toolName: string,
  request: http.IncomingMessage,
  response: http.ServerResponse
): Promise<void> {
  const manifest = readManifest(toolName);
  if (manifest === null) {
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "Tool not found" }));
    return;
  }

  const body = await readRequestBody(request);
  const toolDir = path.join(TOOLS_DIR, toolName);

  console.log(`[stavrobot-tool-runner] Running tool: ${toolName}, entrypoint: ${manifest.entrypoint}`);

  const entrypoint = path.join(toolDir, manifest.entrypoint);

  const { uid, gid } = getToolRunnerIds();

  await new Promise<void>((resolve) => {
    const child = spawn(entrypoint, [], {
      cwd: toolDir,
      uid,
      gid,
      env: {
        PATH: process.env.PATH,
        UV_CACHE_DIR: "/tmp/uv-cache",
        UV_PYTHON_INSTALL_DIR: "/opt/uv/python",
      },
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, TOOL_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });

    child.stdin.on("error", (error: Error) => {
      // EPIPE means the child exited before reading stdin. This is not fatal
      // since the child's exit handler will report the actual error.
      if ((error as NodeJS.ErrnoException).code !== "EPIPE") {
        console.error(`[stavrobot-tool-runner] Tool ${toolName} stdin error: ${error.message}`);
      }
    });

    child.stdin.write(body);
    child.stdin.end();

    child.on("error", (error: Error) => {
      clearTimeout(timer);
      console.error(`[stavrobot-tool-runner] Tool ${toolName} failed to spawn: ${error.message}`);
      response.writeHead(500, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ success: false, error: `Failed to spawn tool: ${error.message}` }));
      resolve();
    });

    child.on("close", (code: number | null) => {
      clearTimeout(timer);

      if (timedOut) {
        console.error(`[stavrobot-tool-runner] Tool ${toolName} timed out after ${TOOL_TIMEOUT_MS}ms`);
        response.writeHead(500, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ success: false, error: "Tool execution timed out" }));
        resolve();
        return;
      }

      if (code !== 0) {
        console.error(`[stavrobot-tool-runner] Tool ${toolName} exited with code ${code}: ${stderr}`);
        response.writeHead(500, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ success: false, error: stderr }));
        resolve();
        return;
      }

      let output: unknown;
      try {
        output = JSON.parse(stdout);
      } catch {
        output = stdout;
      }

      console.log(`[stavrobot-tool-runner] Tool ${toolName} completed successfully`);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ success: true, output }));
      resolve();
    });
  });
}

async function handleRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
): Promise<void> {
  const url = request.url ?? "/";
  const method = request.method ?? "GET";

  console.log(`[stavrobot-tool-runner] ${method} ${url}`);

  try {
    if (method === "GET" && url === "/tools") {
      handleListTools(response);
      return;
    }

    const getToolMatch = url.match(/^\/tools\/([^/]+)$/);
    if (method === "GET" && getToolMatch !== null) {
      handleGetTool(getToolMatch[1], response);
      return;
    }

    const runToolMatch = url.match(/^\/tools\/([^/]+)\/run$/);
    if (method === "POST" && runToolMatch !== null) {
      await handleRunTool(runToolMatch[1], request, response);
      return;
    }

    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "Not found" }));
  } catch (error) {
    console.error("[stavrobot-tool-runner] Error handling request:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    response.writeHead(500, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: errorMessage }));
  }
}

async function main(): Promise<void> {
  const server = http.createServer((request: http.IncomingMessage, response: http.ServerResponse): void => {
    handleRequest(request, response);
  });

  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3001;
  server.listen(port, () => {
    console.log(`[stavrobot-tool-runner] Server listening on port ${port}`);
  });
}

main();
