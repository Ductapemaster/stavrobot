export async function sendTelegramMessage(botToken: string, chatId: string, text: string): Promise<void> {
  console.log("[stavrobot] sendTelegramMessage called:", { chatId, textLength: text.length });

  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
  });

  if (!response.ok) {
    const errorBody = await response.json() as { description?: string };
    const description = errorBody.description ?? "unknown error";
    throw new Error(`Telegram API error ${response.status}: ${description}`);
  }

  console.log("[stavrobot] sendTelegramMessage response status:", response.status);
}
