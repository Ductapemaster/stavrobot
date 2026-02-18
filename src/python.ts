import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execSync, spawn } from "node:child_process";
import { Type } from "@mariozechner/pi-ai";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";

const TIMEOUT_SECONDS = 30;

let pythonRunnerUid: number | undefined;
let pythonRunnerGid: number | undefined;

function getPythonRunnerIds(): { uid: number; gid: number } {
  if (pythonRunnerUid === undefined || pythonRunnerGid === undefined) {
    try {
      pythonRunnerUid = parseInt(execSync("id -u pythonrunner").toString().trim(), 10);
      pythonRunnerGid = parseInt(execSync("id -g pythonrunner").toString().trim(), 10);
    } catch {
      throw new Error("pythonrunner user not found — run_python requires the Docker container environment");
    }
  }
  return { uid: pythonRunnerUid, gid: pythonRunnerGid };
}

function buildScriptContent(code: string, dependencies: string[]): string {
  if (dependencies.length === 0) {
    return code;
  }
  // PEP 723 inline script metadata block.
  const metadataBlock = [
    "# /// script",
    `# dependencies = [${dependencies.map((dep) => `"${dep}"`).join(", ")}]`,
    "# ///",
  ].join("\n");
  return `${metadataBlock}\n${code}`;
}

export function createRunPythonTool(): AgentTool {
  return {
    name: "run_python",
    label: "Run Python",
    description:
      "Execute a Python script. The code runs via uv and can use any pip package by " +
      "specifying dependencies. Returns stdout and stderr from the script.",
    parameters: Type.Object({
      code: Type.String({ description: "The Python code to execute." }),
      dependencies: Type.Optional(
        Type.Array(Type.String(), {
          description: "Pip package specifiers (e.g. [\"requests\", \"numpy>=1.24\"]).",
        }),
      ),
    }),
    execute: async (
      toolCallId: string,
      params: unknown,
    ): Promise<AgentToolResult<{ result: string }>> => {
      const { code, dependencies = [] } = params as {
        code: string;
        dependencies?: string[];
      };

      console.log(
        `[stavrobot] run_python called: code length=${code.length}, dependencies=${dependencies.length}`,
      );

      const { uid, gid } = getPythonRunnerIds();
      const scriptContent = buildScriptContent(code, dependencies);
      const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "python-"));
      await fs.chmod(tempDirectory, 0o755);
      const scriptPath = path.join(tempDirectory, "script.py");

      try {
        await fs.writeFile(scriptPath, scriptContent, "utf8");

        const result = await new Promise<string>((resolve) => {
          let stdoutBuffer = "";
          let stderrBuffer = "";
          let timedOut = false;

          const child = spawn("uv", ["run", scriptPath], {
            uid,
            gid,
            cwd: "/app/data",
            env: {
              PATH: process.env.PATH,
              UV_CACHE_DIR: "/tmp/uv-cache",
              UV_PYTHON_INSTALL_DIR: "/opt/uv/python",
            },
          });

          child.stdout.on("data", (chunk: Buffer) => {
            stdoutBuffer += chunk.toString();
          });

          child.stderr.on("data", (chunk: Buffer) => {
            stderrBuffer += chunk.toString();
          });

          const timer = setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
            // Give the process 5 seconds to exit cleanly before forcing it.
            const killTimer = setTimeout(() => {
              child.kill("SIGKILL");
            }, 5000);
            child.on("close", () => {
              clearTimeout(killTimer);
            });
          }, TIMEOUT_SECONDS * 1000);

          let settled = false;

          child.on("error", (error: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            let output = stdoutBuffer;
            if (stderrBuffer.length > 0) {
              output += (output.length > 0 ? "\n" : "") + `stderr:\n${stderrBuffer}`;
            }
            output += (output.length > 0 ? "\n" : "") + `Failed to spawn process: ${error.message}`;
            console.error(`[stavrobot] run_python spawn error: ${error.message}`);
            resolve(output);
          });

          child.on("close", (exitCode) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);

            let output = stdoutBuffer;
            if (stderrBuffer.length > 0) {
              output += (output.length > 0 ? "\n" : "") + `stderr:\n${stderrBuffer}`;
            }

            if (timedOut) {
              output += (output.length > 0 ? "\n" : "") + `Process timed out after ${TIMEOUT_SECONDS} seconds.`;
              console.log(`[stavrobot] run_python timed out, partial output length=${output.length}`);
              resolve(output.length > 0 ? output : `Process timed out after ${TIMEOUT_SECONDS} seconds.`);
              return;
            }

            if (exitCode !== 0) {
              output += (output.length > 0 ? "\n" : "") + `Exit code: ${exitCode}.`;
              console.log(`[stavrobot] run_python failed with exit code ${exitCode}, output length=${output.length}`);
              resolve(output.length > 0 ? output : `Script exited with code ${exitCode} and produced no output.`);
              return;
            }

            if (output.length === 0) {
              console.log("[stavrobot] run_python succeeded with no output");
              resolve("Script produced no output.");
              return;
            }

            console.log(`[stavrobot] run_python succeeded, output length=${output.length}`);
            resolve(output);
          });
        });

        return {
          content: [{ type: "text" as const, text: result }],
          details: { result },
        };
      } finally {
        await fs.rm(tempDirectory, { recursive: true });
      }
    },
  };
}
