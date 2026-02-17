import fs from "fs";
import type { OAuthCredentials } from "@mariozechner/pi-ai";
import { getOAuthApiKey } from "@mariozechner/pi-ai";
import type { Config } from "./config.js";

type CredentialsMap = Record<string, OAuthCredentials>;

const MAX_RETRIES = 3;
const BASE_DELAY_MILLISECONDS = 1000;

async function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// Retrieves an API key, either directly from config or by resolving OAuth
// credentials from the auth file. When using OAuth, refreshed credentials are
// persisted back to disk so subsequent calls reuse the updated token. Retries
// with exponential backoff on transient failures to handle cases where the
// Anthropic OAuth endpoint is temporarily unreachable.
export async function getApiKey(config: Config): Promise<string> {
  if (config.apiKey !== undefined) {
    return config.apiKey;
  }

  const authFile = config.authFile as string;

  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const credentials = JSON.parse(fs.readFileSync(authFile, "utf-8")) as CredentialsMap;

      const result = await getOAuthApiKey(config.provider, credentials);
      if (result === null) {
        throw new Error(`No OAuth credentials found for provider "${config.provider}" in ${authFile}. Run the Pi coding agent /login command to authenticate.`);
      }

      credentials[config.provider] = result.newCredentials;
      fs.writeFileSync(authFile, JSON.stringify(credentials, null, 2));

      if (attempt > 0) {
        console.log(`[stavrobot] OAuth token resolved after ${attempt + 1} attempts.`);
      }

      return result.apiKey;
    } catch (error) {
      lastError = error;
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Missing credentials is not a transient failure, no point retrying.
      if (errorMessage.includes("No OAuth credentials found")) {
        throw error;
      }

      const delayMilliseconds = BASE_DELAY_MILLISECONDS * Math.pow(2, attempt);
      console.error(`[stavrobot] OAuth token refresh failed (attempt ${attempt + 1}/${MAX_RETRIES}): ${errorMessage}. Retrying in ${delayMilliseconds}ms...`);
      await sleep(delayMilliseconds);
    }
  }

  const finalMessage = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`OAuth token refresh failed after ${MAX_RETRIES} attempts: ${finalMessage}`);
}
