import { describe, it, expect, vi, beforeEach } from "vitest";
import type pg from "pg";
import type { Agent } from "@mariozechner/pi-agent-core";
import type { Config } from "./config.js";
import { AuthError } from "./auth.js";

// Mock the modules that processQueue depends on so tests don't need real infrastructure.
vi.mock("./agent.js", () => ({
  handlePrompt: vi.fn(),
}));
vi.mock("./signal.js", () => ({
  sendSignalMessage: vi.fn(),
}));
vi.mock("./telegram-api.js", () => ({
  sendTelegramMessage: vi.fn(),
}));

import { handlePrompt } from "./agent.js";
import { initializeQueue, enqueueMessage } from "./queue.js";

const mockHandlePrompt = vi.mocked(handlePrompt);

// Minimal stubs — the queue only passes these through to handlePrompt, which is mocked.
const stubAgent = {} as unknown as Agent;
const stubPool = {} as unknown as pg.Pool;
const stubConfig = { publicHostname: "http://localhost" } as unknown as Config;

beforeEach(() => {
  vi.clearAllMocks();
  initializeQueue(stubAgent, stubPool, stubConfig);
});

describe("processQueue non-retryable 400 error handling", () => {
  it("resolves with a user-facing message immediately when the error contains '400 {'", async () => {
    mockHandlePrompt.mockRejectedValueOnce(
      new Error('Agent error: "400 {"type":"error","error":{"type":"invalid_request_error","message":"orphaned tool_result"}}"'),
    );

    const result = await enqueueMessage("hello");

    expect(result).toBe("Something went wrong processing your message. Please try again.");
    // handlePrompt was called exactly once — no retry.
    expect(mockHandlePrompt).toHaveBeenCalledTimes(1);
  });

  it("retries when the error does not contain '400 {'", async () => {
    // Fail twice with a 500-style error, then succeed.
    mockHandlePrompt
      .mockRejectedValueOnce(new Error("network timeout"))
      .mockRejectedValueOnce(new Error("network timeout"))
      .mockResolvedValueOnce("ok");

    // Override the sleep delay to zero so the test doesn't take 60 s.
    vi.useFakeTimers();
    const resultPromise = enqueueMessage("hello");
    // Advance past both retry delays.
    await vi.runAllTimersAsync();
    vi.useRealTimers();

    const result = await resultPromise;
    expect(result).toBe("ok");
    expect(mockHandlePrompt).toHaveBeenCalledTimes(3);
  });

  it("resolves with the auth message and does not retry on AuthError", async () => {
    mockHandlePrompt.mockRejectedValueOnce(new AuthError("token expired"));

    const result = await enqueueMessage("hello");

    expect(result).toContain("Authentication required");
    expect(mockHandlePrompt).toHaveBeenCalledTimes(1);
  });
});
