interface NgrokTunnel {
  proto: string;
  public_url: string;
}

interface NgrokTunnelsResponse {
  tunnels: NgrokTunnel[];
}

function isNgrokTunnelsResponse(value: unknown): value is NgrokTunnelsResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "tunnels" in value &&
    Array.isArray((value as Record<string, unknown>).tunnels)
  );
}

// Polls the ngrok local API until an HTTPS tunnel is available, then returns
// the public URL. Retries for up to 60 seconds (30 attempts × 2-second delay).
export async function fetchNgrokPublicUrl(apiUrl: string): Promise<string> {
  const maxAttempts = 30;
  const retryDelayMs = 2000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch(`${apiUrl}/api/tunnels`);
      const data = await response.json() as unknown;
      if (isNgrokTunnelsResponse(data)) {
        const httpsTunnel = data.tunnels.find(
          (tunnel): tunnel is NgrokTunnel =>
            typeof tunnel === "object" &&
            tunnel !== null &&
            tunnel.proto === "https",
        );
        if (httpsTunnel !== undefined) {
          return httpsTunnel.public_url;
        }
      }
    } catch {
      // ngrok not ready yet, will retry
    }
    if (attempt < maxAttempts) {
      console.log(`[stavrobot] Waiting for ngrok tunnel... (attempt ${attempt}/${maxAttempts})`);
      await new Promise<void>((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }

  throw new Error("Failed to get ngrok public URL after maximum attempts.");
}
