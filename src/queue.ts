import type pg from "pg";
import type { Agent } from "@mariozechner/pi-agent-core";
import type { Config } from "./config.js";
import { handlePrompt } from "./agent.js";

interface QueueEntry {
  message: string;
  source: string | undefined;
  sender: string | undefined;
  resolve: (value: string) => void;
  reject: (reason: unknown) => void;
}

const queue: QueueEntry[] = [];
let processing = false;

let queueAgent: Agent | undefined;
let queuePool: pg.Pool | undefined;
let queueConfig: Config | undefined;

export function initializeQueue(agent: Agent, pool: pg.Pool, config: Config): void {
  queueAgent = agent;
  queuePool = pool;
  queueConfig = config;
}

async function processQueue(): Promise<void> {
  processing = true;
  while (queue.length > 0) {
    const entry = queue.shift()!;
    try {
      const response = await handlePrompt(queueAgent!, queuePool!, entry.message, queueConfig!, entry.source, entry.sender);
      entry.resolve(response);
    } catch (error) {
      entry.reject(error);
    }
  }
  processing = false;
}

export function enqueueMessage(message: string, source?: string, sender?: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    queue.push({ message, source, sender, resolve, reject });
    if (!processing) {
      void processQueue();
    }
  });
}
