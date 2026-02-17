import {
  AuthStorage,
  ModelRegistry,
  SessionManager,
  createAgentSession,
  DefaultResourceLoader,
} from "@mariozechner/pi-coding-agent";
import type { CoderConfig } from "./config.js";

const SYSTEM_PROMPT = `You are a coding agent that creates and maintains tools. Tools live in /tools/ as subdirectories.
Each tool directory contains:
- manifest.json: { "name": "tool_name", "description": "what it does", "entrypoint": "run.py", "parameters": { "paramName": { "type": "string", "description": "..." } } }
- An executable script (the entrypoint).

Scripts receive a JSON object on stdin (the parameters) and must write a JSON object to stdout (the result).
Python scripts should use a uv shebang line (#!/usr/bin/env -S uv run) so dependencies are fetched at runtime.
Scripts must be executable (chmod +x).

When creating a tool, always test it by running it with sample input before declaring it complete.`;

const APP_CHAT_URL = "http://app:3000/chat";

export async function handleCodingTask(
  taskId: string,
  message: string,
  config: CoderConfig,
): Promise<void> {
  console.log(`[stavrobot-coder] Starting coding task ${taskId}`);

  let resultText: string | undefined;
  try {
    const authStorage =
      config.authFile !== undefined
        ? AuthStorage.create(config.authFile)
        : AuthStorage.create();

    if (config.apiKey !== undefined) {
      authStorage.setRuntimeApiKey(config.provider, config.apiKey);
    }

    const modelRegistry = new ModelRegistry(authStorage);
    const model = modelRegistry.find(config.provider, config.coderModel);
    if (model === undefined) {
      throw new Error(
        `Model ${config.provider}/${config.coderModel} not found in registry.`,
      );
    }

    const resourceLoader = new DefaultResourceLoader({
      systemPromptOverride: () => SYSTEM_PROMPT,
    });
    await resourceLoader.reload();

    const { session } = await createAgentSession({
      authStorage,
      modelRegistry,
      model,
      thinkingLevel: "medium",
      sessionManager: SessionManager.inMemory(),
      resourceLoader,
    });

    console.log(
      `[stavrobot-coder] Sending prompt for task ${taskId}: ${message.slice(0, 100)}`,
    );
    await session.prompt(message);

    const lastAssistantMessage = session.messages
      .slice()
      .reverse()
      .find((message) => message.role === "assistant");
    if (lastAssistantMessage !== undefined) {
      const content = Array.isArray(lastAssistantMessage.content) ? lastAssistantMessage.content : [];
      resultText = content
        .filter((block): block is { type: "text"; text: string } => block.type === "text")
        .map((block) => block.text)
        .join("");
    }
    if (resultText === undefined || resultText === "") {
      resultText = "Coding task completed with no assistant output.";
    }

    console.log(
      `[stavrobot-coder] Task ${taskId} completed, result length: ${resultText.length}`,
    );

    session.dispose();
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    console.error(
      `[stavrobot-coder] Task ${taskId} failed: ${errorMessage}`,
    );
    resultText = `Coding task failed: ${errorMessage}`;
  }

  console.log(`[stavrobot-coder] Posting result for task ${taskId} to app`);
  const response = await fetch(APP_CHAT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: resultText,
      source: "coder",
      sender: "coder-agent",
    }),
  });
  if (!response.ok) {
    console.error(
      `[stavrobot-coder] Failed to post result for task ${taskId}: HTTP ${response.status}`,
    );
  } else {
    console.log(
      `[stavrobot-coder] Result for task ${taskId} posted successfully`,
    );
  }
}
