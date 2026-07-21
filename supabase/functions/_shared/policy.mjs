// Credit policy + the /add decision engine (decision D14).
//
// FREE tier (direct adapters + generic JSON-LD fallback) = tracked immediately,
// no key, checked on the normal cadence. DEFENDED (unblocker) = opt-in with the
// user's OWN unblocker key (any provider in providers.mjs), capped at
// MAX_DEFENDED items, and checked at a cadence set by what each store COSTS —
// 6h for a 1-credit store, daily for a 10-credit one — to protect their credits.
// Unsupported = logged (demand signal) + a friendly no.
//
// planAdd() is pure (inject detectAdapter + the user's context) so it's testable
// and portable (Node + Deno).

export const MAX_ITEMS = 20;               // per user, total list size
export const MAX_DEFENDED = 5;             // per user, their own key
export const FREE_INTERVAL_MIN = 360;      // DEFAULT: every 6h
export const MIN_INTERVAL_MIN = 180;       // FLOOR: never faster than 3h
export const DEFENDED_INTERVAL_MIN = 1440; // fallback until a check reveals the real tier cost

// ── measured credit costs (Scrape.do, 2026-07-21) ───────────────────────────
// Real numbers beat the worst case we used to assume. Knowing what a check
// actually costs is what lets us quote a price at /add and set a sane cadence.
export const TIER_COST = { plain: 1, render: 5, premium: 5, super: 10, super_render: 15, stealth: 25 };

// What each defended brand needs BEFORE its first check teaches us for certain.
export const ADAPTER_TIER = {
  bershka: "plain", stradivarius: "plain", asos: "plain", amazon: "plain", farfetch: "plain", ebay: "plain",
  stories: "plain", // measured 2026-07-21: answers a plain request, not render
  inditex: "render", zara: "super", mrporter: "super",
};

// Cadence by cost, not by the blunt "is it defended". A 1-credit check every 6h
// costs 120/month — trivial — and alerts four times sooner, which is the whole
// point of the product.
export const TIER_INTERVAL_MIN = { plain: 360, render: 1440, premium: 1440, super: 1440, super_render: 1440, stealth: 1440 };

/** Rough credits per month for one product at a given cadence. */
export function monthlyCredits(tier, intervalMinutes) {
  const cost = TIER_COST[tier] ?? TIER_COST.render;
  const checksPerMonth = (30 * 24 * 60) / Math.max(1, intervalMinutes);
  return Math.round(cost * checksPerMonth);
}

// What /every accepts. 3h is the floor because a shop that sells out inside
// three hours is rare, and polling faster mostly buys bans, not saves.
export const INTERVAL_OPTIONS = { "3h": 180, "6h": 360, "12h": 720, "1d": 1440 };

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
          "That brand is bot-protected, so it needs an unblocker. Add your own key with /setkey to track it — /providers shows the options " +
          `(up to ${MAX_DEFENDED} such items — how often depends on what that shop costs to check) — or send me a supported store instead.`,
      };
    }
    if (ctx.userDefendedCount >= MAX_DEFENDED) {
      return {
        action: "cap_reached",
        adapter: det.adapter,
        message: `You're at the limit of ${MAX_DEFENDED} defended items (they spend your own unblocker credits). Remove one with /remove to add this.`,
      };
    }
    return {
      action: "track",
      adapter: det.adapter,
      strategy: "unblocker",
      intervalMinutes: DEFENDED_INTERVAL_MIN,
      hints: det.hints,
      message: "Tracking this (bot-protected — uses your key).",
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
