import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@mariozechner/pi-ai";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { UPLOADS_DIR } from "./uploads.js";

function validateFilename(filename: string): string | null {
  if (!filename.startsWith("upload-") || filename.includes("/") || filename.includes("\\") || filename.includes("..")) {
    return "Invalid filename: must start with 'upload-' and must not contain '/', '\\', or '..'.";
  }
  return null;
}

export function createReadUploadTool(): AgentTool {
  return {
    name: "read_upload",
    label: "Read upload",
    description: "Read the text contents of an uploaded file by its stored filename.",
    parameters: Type.Object({
      filename: Type.String({ description: "The stored filename of the upload, e.g. upload-abc123.txt." }),
    }),
    execute: async (
      toolCallId: string,
      params: unknown
    ): Promise<AgentToolResult<{ message: string }>> => {
      const { filename } = params as { filename: string };

      console.log("[stavrobot] read_upload called:", filename);

      const validationError = validateFilename(filename);
      if (validationError !== null) {
        console.warn("[stavrobot] read_upload validation failed:", validationError);
        return {
          content: [{ type: "text" as const, text: validationError }],
          details: { message: validationError },
        };
      }

      const filePath = path.join(UPLOADS_DIR, filename);

      let contents: string;
      try {
        contents = await fs.readFile(filePath, "utf-8");
      } catch (error) {
        const isNotFound = error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
        if (!isNotFound) {
          throw error;
        }
        const message = `File not found: ${filename}`;
        console.warn("[stavrobot] read_upload error:", message);
        return {
          content: [{ type: "text" as const, text: message }],
          details: { message },
        };
      }

      console.log("[stavrobot] read_upload result: read", contents.length, "characters from", filename);

      return {
        content: [{ type: "text" as const, text: contents }],
        details: { message: `Read ${contents.length} characters from ${filename}.` },
      };
    },
  };
}

export function createDeleteUploadTool(): AgentTool {
  return {
    name: "delete_upload",
    label: "Delete upload",
    description: "Delete an uploaded file by its stored filename.",
    parameters: Type.Object({
      filename: Type.String({ description: "The stored filename of the upload, e.g. upload-abc123.txt." }),
    }),
    execute: async (
      toolCallId: string,
      params: unknown
    ): Promise<AgentToolResult<{ message: string }>> => {
      const { filename } = params as { filename: string };

      console.log("[stavrobot] delete_upload called:", filename);

      const validationError = validateFilename(filename);
      if (validationError !== null) {
        console.warn("[stavrobot] delete_upload validation failed:", validationError);
        return {
          content: [{ type: "text" as const, text: validationError }],
          details: { message: validationError },
        };
      }

      const filePath = path.join(UPLOADS_DIR, filename);

      try {
        await fs.unlink(filePath);
      } catch (error) {
        const isNotFound = error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
        if (!isNotFound) {
          throw error;
        }
        const message = `File not found: ${filename}`;
        console.warn("[stavrobot] delete_upload error:", message);
        return {
          content: [{ type: "text" as const, text: message }],
          details: { message },
        };
      }

      const message = `File deleted: ${filename}`;
      console.log("[stavrobot] delete_upload result:", message);

      return {
        content: [{ type: "text" as const, text: message }],
        details: { message },
      };
    },
  };
}
