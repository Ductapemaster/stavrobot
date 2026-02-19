export async function sendSignalMessage(recipient: string, message: string): Promise<void> {
  console.log("[stavrobot] sendSignalMessage called:", { recipient, messageLength: message.length });

  const response = await fetch("http://signal-bridge:8081/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ recipient, message }),
  });

  const responseText = await response.text();

  if (!response.ok) {
    let errorMessage = responseText;
    try {
      const parsed = JSON.parse(responseText) as unknown;
      if (typeof parsed === "object" && parsed !== null && "error" in parsed && typeof (parsed as { error: unknown }).error === "string") {
        errorMessage = (parsed as { error: string }).error;
      }
    } catch {
      // Fall back to raw text if JSON parsing fails.
    }
    throw new Error(`Signal bridge error ${response.status}: ${errorMessage}`);
  }

  try {
    const parsed = JSON.parse(responseText) as unknown;
    if (typeof parsed !== "object" || parsed === null || !("ok" in parsed) || (parsed as { ok: unknown }).ok !== true) {
      throw new Error(`Signal bridge returned unexpected response: ${responseText}`);
    }
  } catch (parseError) {
    if (parseError instanceof SyntaxError) {
      throw new Error(`Signal bridge returned non-JSON success response: ${responseText}`);
    }
    throw parseError;
  }

  console.log("[stavrobot] sendSignalMessage bridge response status:", response.status);
}
