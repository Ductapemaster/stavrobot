import fs from "fs";
import TOML from "@iarna/toml";

export interface CoderConfig {
  provider: string;
  coderModel: string;
  apiKey?: string;
  authFile?: string;
}

interface RawConfig {
  provider: string;
  apiKey?: string;
  authFile?: string;
  coder?: {
    model: string;
  };
}

export function loadCoderConfig(): CoderConfig {
  const configPath = process.env.CONFIG_PATH || "config.toml";
  const configContent = fs.readFileSync(configPath, "utf-8");
  const raw = TOML.parse(configContent) as unknown as RawConfig;

  if (raw.coder === undefined) {
    throw new Error("Config is missing required [coder] section.");
  }

  if (raw.apiKey === undefined && raw.authFile === undefined) {
    throw new Error("Config must specify either apiKey or authFile.");
  }
  if (raw.apiKey !== undefined && raw.authFile !== undefined) {
    throw new Error("Config must specify either apiKey or authFile, not both.");
  }

  return {
    provider: raw.provider,
    coderModel: raw.coder.model,
    apiKey: raw.apiKey,
    authFile: raw.authFile,
  };
}
