import fs from "node:fs/promises";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { TextContent } from "@mariozechner/pi-ai";
import { createReadUploadTool, createDeleteUploadTool } from "./upload-tools.js";
import { UPLOADS_DIR } from "./uploads.js";

function asText(content: unknown): string {
  const item = content as TextContent;
  return item.text;
}

async function writeTestFile(filename: string, content: string): Promise<string> {
  await fs.mkdir(UPLOADS_DIR, { recursive: true });
  const filePath = path.join(UPLOADS_DIR, filename);
  await fs.writeFile(filePath, content, "utf-8");
  return filePath;
}

async function fileExists(filename: string): Promise<boolean> {
  try {
    await fs.access(path.join(UPLOADS_DIR, filename));
    return true;
  } catch {
    return false;
  }
}

describe("createReadUploadTool", () => {
  const tool = createReadUploadTool();
  const testFilename = "upload-test-read-tool.txt";

  afterEach(async () => {
    try {
      await fs.unlink(path.join(UPLOADS_DIR, testFilename));
    } catch {
      // File may not exist; ignore.
    }
  });

  it("returns file contents for a valid upload file", async () => {
    await writeTestFile(testFilename, "hello from test");
    const result = await tool.execute("call-1", { filename: testFilename });
    expect(asText(result.content[0])).toBe("hello from test");
  });

  it("returns an error message when the file does not exist", async () => {
    const result = await tool.execute("call-2", { filename: "upload-nonexistent-xyz.txt" });
    expect(asText(result.content[0])).toMatch(/not found/i);
  });

  it("rejects filenames that do not start with 'upload-'", async () => {
    const result = await tool.execute("call-3", { filename: "secret.txt" });
    expect(asText(result.content[0])).toMatch(/invalid filename/i);
  });

  it("rejects filenames containing a path separator", async () => {
    const result = await tool.execute("call-4", { filename: "upload-foo/../../etc/passwd" });
    expect(asText(result.content[0])).toMatch(/invalid filename/i);
  });

  it("rejects filenames containing '..'", async () => {
    const result = await tool.execute("call-5", { filename: "upload-..evil" });
    expect(asText(result.content[0])).toMatch(/invalid filename/i);
  });

  it("rejects filenames containing a backslash", async () => {
    const result = await tool.execute("call-6", { filename: "upload-foo\\bar.txt" });
    expect(asText(result.content[0])).toMatch(/invalid filename/i);
  });

  it("throws non-ENOENT filesystem errors instead of swallowing them", async () => {
    vi.spyOn(fs, "readFile").mockRejectedValueOnce(
      Object.assign(new Error("Permission denied"), { code: "EACCES" }),
    );
    await expect(tool.execute("call-7", { filename: "upload-perm-denied.txt" })).rejects.toThrow("Permission denied");
    vi.restoreAllMocks();
  });
});

describe("createDeleteUploadTool", () => {
  const tool = createDeleteUploadTool();
  const testFilename = "upload-test-delete-tool.txt";

  beforeEach(async () => {
    await writeTestFile(testFilename, "to be deleted");
  });

  afterEach(async () => {
    try {
      await fs.unlink(path.join(UPLOADS_DIR, testFilename));
    } catch {
      // File may already be deleted; ignore.
    }
  });

  it("deletes the file and returns a success message", async () => {
    const result = await tool.execute("call-1", { filename: testFilename });
    expect(asText(result.content[0])).toMatch(/deleted/i);
    expect(await fileExists(testFilename)).toBe(false);
  });

  it("returns a 'not found' message when the file does not exist", async () => {
    const result = await tool.execute("call-2", { filename: "upload-nonexistent-xyz.txt" });
    expect(asText(result.content[0])).toMatch(/not found/i);
  });

  it("rejects filenames that do not start with 'upload-'", async () => {
    const result = await tool.execute("call-3", { filename: "secret.txt" });
    expect(asText(result.content[0])).toMatch(/invalid filename/i);
  });

  it("rejects filenames containing a path separator", async () => {
    const result = await tool.execute("call-4", { filename: "upload-foo/../../etc/passwd" });
    expect(asText(result.content[0])).toMatch(/invalid filename/i);
  });

  it("rejects filenames containing '..'", async () => {
    const result = await tool.execute("call-5", { filename: "upload-..evil" });
    expect(asText(result.content[0])).toMatch(/invalid filename/i);
  });

  it("rejects filenames containing a backslash", async () => {
    const result = await tool.execute("call-6", { filename: "upload-foo\\bar.txt" });
    expect(asText(result.content[0])).toMatch(/invalid filename/i);
  });

  it("throws non-ENOENT filesystem errors instead of swallowing them", async () => {
    vi.spyOn(fs, "unlink").mockRejectedValueOnce(
      Object.assign(new Error("Permission denied"), { code: "EACCES" }),
    );
    await expect(tool.execute("call-7", { filename: "upload-perm-denied.txt" })).rejects.toThrow("Permission denied");
    vi.restoreAllMocks();
  });
});
