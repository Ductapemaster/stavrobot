import { describe, it, expect } from "vitest";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { serializeMessagesForSummary } from "./agent.js";

// Helper to build a minimal assistant message without filling in all required
// fields that the serializer never reads (api, provider, model, usage).
function assistantMessage(content: AgentMessage["content"]): AgentMessage {
  return { role: "assistant", content, stopReason: "stop" } as unknown as AgentMessage;
}

// Helper to build a minimal tool result message.
function toolResultMessage(toolName: string, text: string): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: "tc",
    toolName,
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 0,
  } as unknown as AgentMessage;
}

describe("serializeMessagesForSummary", () => {
  it("serializes a plain user message", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "Hello there", timestamp: 0 },
    ];
    expect(serializeMessagesForSummary(messages)).toBe("User: Hello there");
  });

  it("serializes an assistant text-only message", () => {
    const messages: AgentMessage[] = [
      assistantMessage([{ type: "text", text: "Hi!" }]),
    ];
    expect(serializeMessagesForSummary(messages)).toBe("Assistant: Hi!");
  });

  it("serializes a tool call with string arguments", () => {
    const messages: AgentMessage[] = [
      assistantMessage([
        {
          type: "toolCall",
          id: "tc1",
          name: "send_signal_message",
          arguments: { recipient: "+1234567890", message: "Hello!" },
        },
      ]),
    ];
    expect(serializeMessagesForSummary(messages)).toBe(
      `Assistant called send_signal_message(recipient="+1234567890", message="Hello!")`,
    );
  });

  it("serializes a tool call with number and boolean arguments without quotes", () => {
    const messages: AgentMessage[] = [
      assistantMessage([
        {
          type: "toolCall",
          id: "tc2",
          name: "some_tool",
          arguments: { count: 42, enabled: true, disabled: false },
        },
      ]),
    ];
    expect(serializeMessagesForSummary(messages)).toBe(
      "Assistant called some_tool(count=42, enabled=true, disabled=false)",
    );
  });

  it("serializes a tool call with null argument without quotes", () => {
    const messages: AgentMessage[] = [
      assistantMessage([
        {
          type: "toolCall",
          id: "tc3",
          name: "some_tool",
          arguments: { value: null },
        },
      ]),
    ];
    expect(serializeMessagesForSummary(messages)).toBe(
      "Assistant called some_tool(value=null)",
    );
  });

  it("serializes a tool call with an object argument using JSON.stringify", () => {
    const messages: AgentMessage[] = [
      assistantMessage([
        {
          type: "toolCall",
          id: "tc4",
          name: "execute_sql",
          arguments: { query: "SELECT 1", options: { timeout: 5000 } },
        },
      ]),
    ];
    expect(serializeMessagesForSummary(messages)).toBe(
      `Assistant called execute_sql(query="SELECT 1", options={"timeout":5000})`,
    );
  });

  it("emits tool call lines after the assistant text line when both are present", () => {
    const messages: AgentMessage[] = [
      assistantMessage([
        { type: "text", text: "Sending now." },
        {
          type: "toolCall",
          id: "tc5",
          name: "send_signal_message",
          arguments: { recipient: "+1", message: "Hi" },
        },
      ]),
    ];
    const result = serializeMessagesForSummary(messages);
    expect(result).toBe(
      `Assistant: Sending now.\nAssistant called send_signal_message(recipient="+1", message="Hi")`,
    );
  });

  it("emits one line per tool call when multiple tool calls are present", () => {
    const messages: AgentMessage[] = [
      assistantMessage([
        {
          type: "toolCall",
          id: "tc6",
          name: "tool_a",
          arguments: { x: "foo" },
        },
        {
          type: "toolCall",
          id: "tc7",
          name: "tool_b",
          arguments: { y: 1 },
        },
      ]),
    ];
    const result = serializeMessagesForSummary(messages);
    expect(result).toBe(
      `Assistant called tool_a(x="foo")\nAssistant called tool_b(y=1)`,
    );
  });

  it("serializes a tool result message", () => {
    const messages: AgentMessage[] = [
      toolResultMessage("execute_sql", "1 row returned"),
    ];
    expect(serializeMessagesForSummary(messages)).toBe(
      "Tool result (execute_sql): 1 row returned",
    );
  });

  it("handles a full conversation with user, assistant text+tool, and tool result", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "Send a message to Alice", timestamp: 0 },
      assistantMessage([
        { type: "text", text: "Sure, sending now." },
        {
          type: "toolCall",
          id: "tc1",
          name: "send_signal_message",
          arguments: { recipient: "+1", message: "Hey Alice!" },
        },
      ]),
      toolResultMessage("send_signal_message", "Message sent successfully."),
    ];
    const result = serializeMessagesForSummary(messages);
    expect(result).toBe(
      [
        "User: Send a message to Alice",
        "Assistant: Sure, sending now.",
        `Assistant called send_signal_message(recipient="+1", message="Hey Alice!")`,
        "Tool result (send_signal_message): Message sent successfully.",
      ].join("\n"),
    );
  });
});
