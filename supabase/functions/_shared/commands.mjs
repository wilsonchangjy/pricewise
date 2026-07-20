// Telegram command parser → structured intents. Pure + portable; the webhook
// Edge Function maps intents to DB actions and replies.
//
// Supported: /add <url> (or a bare URL), /list, /remove <n>, /setprice <n> <p>,
// /pause <n>, /resume <n>, /setkey <key> (secret — webhook deletes the message),
// /start, /help.

const URL_RE = /https?:\/\/[^\s]+/i;

/**
 * @param {string} text  the raw message text
 * @returns {{cmd:string, url?:string, ref?:string, price?:number, key?:string, redactMessage?:boolean, message?:string}}
 */
export function parseCommand(text) {
  const raw = (text ?? "").trim();
  if (!raw) return { cmd: "unknown" };

  // A bare URL (no slash-command) is shorthand for /add — the "share a link" flow.
  if (!raw.startsWith("/") && URL_RE.test(raw)) {
    return { cmd: "add", url: raw.match(URL_RE)[0] };
  }

  const [word, ...rest] = raw.split(/\s+/);
  const cmd = word.toLowerCase().replace(/@.*$/, ""); // strip @botname
  const arg = rest.join(" ").trim();

  switch (cmd) {
    case "/start":
    case "/help":
      return { cmd: "help" };
    case "/add": {
      const m = arg.match(URL_RE);
      return m ? { cmd: "add", url: m[0] } : { cmd: "add", message: "Send me a product URL: /add https://…" };
    }
    case "/list":
      return { cmd: "list" };
    case "/remove":
    case "/delete":
      return arg ? { cmd: "remove", ref: arg } : { cmd: "remove", message: "Which one? /remove <number from /list>" };
    case "/pause":
      return arg ? { cmd: "pause", ref: arg } : { cmd: "pause", message: "Which one? /pause <number>" };
    case "/resume":
      return arg ? { cmd: "resume", ref: arg } : { cmd: "resume", message: "Which one? /resume <number>" };
    case "/setprice": {
      const [ref, priceStr] = rest;
      const price = Number(priceStr);
      if (!ref || !Number.isFinite(price)) return { cmd: "setprice", message: "Usage: /setprice <number> <price>" };
      return { cmd: "setprice", ref, price };
    }
    case "/size":
    case "/variant": {
      // "/size 2 M" or "/size 2 Navy / 32inch" — free text, matched against the
      // size labels the shop actually returned (see the webhook's matchVariant).
      const [ref, ...rest2] = rest;
      const value = rest2.join(" ").trim();
      if (!ref || !value) return { cmd: "size", message: "Usage: /size <number from /list> <your size>  e.g. /size 2 M" };
      return { cmd: "size", ref, value };
    }
    case "/history":
    case "/price": {
      const [ref, range] = rest;
      if (!ref) return { cmd: "history", message: "Usage: /history <number from /list> [1m|3m|6m|1y]" };
      return { cmd: "history", ref, value: (range ?? "3m").toLowerCase() };
    }
    case "/every": {
      const [ref, value] = rest;
      if (!ref || !value) return { cmd: "every", message: "Usage: /every <number from /list> <3h|6h|12h|1d>" };
      return { cmd: "every", ref, value: value.toLowerCase() };
    }
    case "/setkey": {
      // Secret — tell the webhook to delete the user's message from the chat.
      if (!arg) return { cmd: "setkey", redactMessage: false, message: "Usage: /setkey <your ScrapingBee key>" };
      return { cmd: "setkey", key: arg, redactMessage: true };
    }
    default:
      return { cmd: "unknown", message: "Unknown command. Try /help." };
  }
}
