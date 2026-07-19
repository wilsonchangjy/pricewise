// Credit policy + the /add decision engine (decision D14).
//
// FREE tier (direct adapters + generic JSON-LD fallback) = tracked immediately,
// no key, checked on the normal cadence. DEFENDED (unblocker) = opt-in with the
// user's OWN ScrapingBee key, capped at MAX_DEFENDED items, checked DAILY to
// protect their credits. Unsupported = logged (demand signal) + a friendly no.
//
// planAdd() is pure (inject detectAdapter + the user's context) so it's testable
// and portable (Node + Deno).

export const MAX_DEFENDED = 5;            // per user, their own key
export const FREE_INTERVAL_MIN = 180;     // every 3h
export const DEFENDED_INTERVAL_MIN = 1440; // once a day

/**
 * @param {string} url
 * @param {{
 *   detectAdapter: (url:string) => Promise<{adapter:string|null, strategy?:string, hints?:object}>,
 *   userHasKey: boolean,
 *   userDefendedCount: number,
 * }} ctx
 * @returns {Promise<{action:string, adapter?:string, strategy?:string, intervalMinutes?:number, hints?:object, logRequest?:boolean, message:string}>}
 */
export async function planAdd(url, ctx) {
  const det = await ctx.detectAdapter(url);

  // Step 3 of the fallback: nothing matched (not even generic JSON-LD).
  if (!det.adapter) {
    return {
      action: "unsupported",
      logRequest: true,
      message: `I can't track ${safeHost(url)} yet — I've noted the request and will add support if enough people want it.`,
    };
  }

  // Defended → requires the user's own key + within the cap.
  if (det.strategy === "unblocker") {
    if (!ctx.userHasKey) {
      return {
        action: "need_key",
        adapter: det.adapter,
        message:
          "That brand is bot-protected, so it needs an unblocker. Add your own ScrapingBee key with /setkey to track it " +
          `(up to ${MAX_DEFENDED} such items, checked once a day) — or send me a supported store instead.`,
      };
    }
    if (ctx.userDefendedCount >= MAX_DEFENDED) {
      return {
        action: "cap_reached",
        adapter: det.adapter,
        message: `You're at the limit of ${MAX_DEFENDED} defended items (they use your ScrapingBee credits). Remove one with /remove to add this.`,
      };
    }
    return {
      action: "track",
      adapter: det.adapter,
      strategy: "unblocker",
      intervalMinutes: DEFENDED_INTERVAL_MIN,
      hints: det.hints,
      message: "Tracking this (defended — uses your key, checked daily).",
    };
  }

  // Free — direct adapter or the generic JSON-LD fallback.
  return {
    action: "track",
    adapter: det.adapter,
    strategy: "direct",
    intervalMinutes: FREE_INTERVAL_MIN,
    hints: det.hints,
    message: det.adapter === "jsonld" ? "Tracking this (basic/product-level)." : "Tracking this.",
  };
}

function safeHost(url) {
  try { return new URL(url).hostname; } catch { return "that site"; }
}
