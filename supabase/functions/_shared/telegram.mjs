// Minimal Telegram Bot API client. Plain text only — user-supplied URLs and
// product titles would otherwise break Markdown/HTML parsing (and a failed
// parse means a *dropped alert*, which is the one thing we can't afford).

const API = "https://api.telegram.org/bot";

async function call(token, method, body) {
  try {
    const r = await fetch(`${API}${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) console.error(`telegram ${method} failed:`, j.description ?? r.status);
    return j;
  } catch (e) {
    console.error(`telegram ${method} threw:`, String(e?.message ?? e));
    return { ok: false };
  }
}

export const sendMessage = (token, chatId, text) =>
  call(token, "sendMessage", {
    chat_id: chatId,
    text: String(text).slice(0, 4000),
    disable_web_page_preview: true,
  });

/** Used to scrub /setkey out of the chat history immediately. */
export const deleteMessage = (token, chatId, messageId) =>
  call(token, "deleteMessage", { chat_id: chatId, message_id: messageId });
