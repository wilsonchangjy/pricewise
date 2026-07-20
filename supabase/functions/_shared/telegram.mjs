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

/**
 * @param {object} [opts] `preview: true` lets Telegram render its own link card
 *   from the product URL — image, title, description, for free. That's why alerts
 *   don't need us to attach product photos ourselves. Kept OFF for /list and
 *   /help, where a card per line would bury the text.
 */
export const sendMessage = (token, chatId, text, opts = {}) =>
  call(token, "sendMessage", {
    chat_id: chatId,
    text: String(text).slice(0, 4000),
    disable_web_page_preview: !opts.preview,
    ...(opts.keyboard && { reply_markup: opts.keyboard }),
  });

/**
 * Edit a message in place. Drilling list -> item -> size reuses ONE message
 * instead of leaving a trail of dead menus in a chat people keep for months.
 */
export const editMessage = (token, chatId, messageId, text, opts = {}) =>
  call(token, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text: String(text).slice(0, 4000),
    disable_web_page_preview: !opts.preview,
    ...(opts.keyboard && { reply_markup: opts.keyboard }),
  });

/**
 * MUST be called for every callback_query, even on failure — otherwise the
 * client spins forever on the button the user just tapped.
 */
export const answerCallback = (token, callbackId, text = "", alert = false) =>
  call(token, "answerCallbackQuery", {
    callback_query_id: callbackId,
    ...(text && { text, show_alert: alert }),
  });

/** Used to scrub /setkey out of the chat history immediately. */
export const deleteMessage = (token, chatId, messageId) =>
  call(token, "deleteMessage", { chat_id: chatId, message_id: messageId });

/**
 * Is this chat permanently unreachable (blocked us, deleted their account, gone)?
 *
 * This matters because we only advance a subscriber's alert state after a
 * SUCCESSFUL send — which is right for a transient outage (retry next tick) and
 * very wrong for someone who blocked the bot, since that retries forever. A
 * permanent failure has to stop the subscription instead.
 *
 * @param {{ok?:boolean, error_code?:number, description?:string}} res
 */
export function isUnreachable(res) {
  if (!res || res.ok) return false;
  if (res.error_code === 403) return true; // blocked us / deactivated / can't initiate
  return res.error_code === 400 && /chat not found|user not found/i.test(res.description ?? "");
}
