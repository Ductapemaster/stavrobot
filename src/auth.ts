import fs from "fs";
import type { OAuthCredentials } from "@mariozechner/pi-ai";
import { getOAuthApiKey } from "@mariozechner/pi-ai";
import type { Config } from "./config.js";

type CredentialsMap = Record<string, OAuthCredentials>;

// Retrieves an API key, either directly from config or by resolving OAuth
// credentials from the auth file. When using OAuth, refreshed credentials are
// persisted back to disk so subsequent calls reuse the updated token.
export async function getApiKey(config: Config): Promise<string> {
  if (config.apiKey !== undefined) {
    return config.apiKey;
  }

  const authFile = config.authFile as string;
  const credentials = JSON.parse(fs.readFileSync(authFile, "utf-8")) as CredentialsMap;

  const result = await getOAuthApiKey(config.provider, credentials);
  if (result === null) {
    throw new Error(`No OAuth credentials found for provider "${config.provider}" in ${authFile}. Run the Pi coding agent /login command to authenticate.`);
  }

  credentials[config.provider] = result.newCredentials;
  fs.writeFileSync(authFile, JSON.stringify(credentials, null, 2));

  return result.apiKey;
}
