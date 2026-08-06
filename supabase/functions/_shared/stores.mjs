// The supported-store list — ONE source of truth.
//
// This existed in four places and had already drifted: the README's bracket
// list, the /help text, the /providers blurb ("Amazon, eBay, Zara, Massimo
// Dutti, ASOS…") and /prefs ("Zara, Amazon, ASOS…"), which still omitted eBay,
// Farfetch and MR PORTER months after they shipped. Anything user-facing that
// names stores should read from here.
//
// Only the NAME and the per-size claim live here. Whether a store needs a key,
// and what it costs, are DERIVED from router.strategyFor() and policy.ADAPTER_TIER
// at render time — so a store can never be advertised as free after being moved
// into DEFENDED.

import { strategyFor, KNOWN_HOSTS } from "./router.mjs";
import { ADAPTER_TIER, TIER_COST, TIER_INTERVAL_MIN } from "./policy.mjs";

/**
 * @type {{ adapter: string, name: string, perSize: boolean, note?: string }[]}
 * `perSize` means we read stock for EACH size — the thing this bot is for.
 * false means product-level only ("something is available"), which is honest
 * but weaker, and the bot says so at /add.
 */
export const STORES = [
  { adapter: "shopify", name: "Any Shopify store", perSize: true, note: "thousands of independent brands" },
  { adapter: "end", name: "END.", perSize: true, note: "sold-out sizes aren't listed" },
  { adapter: "uniqlo", name: "Uniqlo", perSize: true },
  { adapter: "cos", name: "COS", perSize: true },
  { adapter: "mango", name: "Mango", perSize: true },
  { adapter: "wix", name: "Wix stores", perSize: true },
  { adapter: "woocommerce", name: "Any WooCommerce store", perSize: true, note: "about a third of all shops online" },
  { adapter: "jsonld", name: "Space NK", perSize: true, note: "beauty and skincare; sizes read per variant" },
  { adapter: "jsonld", name: "Lookfantastic", perSize: true, note: "beauty and skincare" },
  { adapter: "jsonld", name: "Cult Beauty", perSize: true, note: "beauty and skincare" },
  { adapter: "jsonld", name: "Most other shops", perSize: false, note: "read automatically where a site publishes standard product data" },

  { adapter: "amazon", name: "Amazon", perSize: true, note: "each size is its own listing" },
  { adapter: "ebay", name: "eBay", perSize: false, note: "fixed-price listings; prices in USD" },
  { adapter: "asos", name: "ASOS", perSize: true },
  { adapter: "zara", name: "Zara", perSize: true },
  { adapter: "inditex", name: "Massimo Dutti & Oysho", perSize: true },
  { adapter: "bershka", name: "Bershka", perSize: true },
  { adapter: "stradivarius", name: "Stradivarius", perSize: true },
  { adapter: "stories", name: "& Other Stories", perSize: true },
  { adapter: "farfetch", name: "Farfetch", perSize: true },
  { adapter: "mrporter", name: "MR PORTER", perSize: true, note: "prices in GBP" },
  { adapter: "netaporter", name: "NET-A-PORTER", perSize: true, note: "prices in USD" },
  { adapter: "cettire", name: "Cettire", perSize: true, note: "prices in USD" },
  { adapter: "ssense", name: "SSENSE", perSize: false, note: "no per-size stock published" },
];

/** Free stores need no key; defended ones spend the user's own credits. */
export const isFree = (adapter) => strategyFor(adapter) !== "unblocker";

/** Split for display, with cost and cadence derived rather than restated. */
export function groupedStores() {
  const decorate = (s) => {
    const tier = ADAPTER_TIER[s.adapter];
    return {
      ...s,
      free: isFree(s.adapter),
      credits: tier ? TIER_COST[tier] : 0,
      everyHours: tier ? (TIER_INTERVAL_MIN[tier] ?? 1440) / 60 : 6,
    };
  };
  const all = STORES.map(decorate);
  return { free: all.filter((s) => s.free), keyed: all.filter((s) => !s.free) };
}

/**
 * Named shops with their domains — for telling a search engine (or a model)
 * WHERE to look. Free ones come first: a candidate we can read for nothing is
 * worth more than one that spends the user's unblocker credits every check.
 *
 * `hasKey` false hides the keyed shops entirely, so someone without an unblocker
 * key is never steered toward a shop we'd then have to refuse to track.
 */
export function searchableStores({ hasKey = true } = {}) {
  const named = new Map(STORES.map((s) => [s.adapter, s.name]));
  const rows = KNOWN_HOSTS
    .map(([host, adapter]) => ({ host, adapter, name: named.get(adapter) ?? adapter, free: isFree(adapter) }))
    .filter((s) => s.free || hasKey);
  return [...rows.filter((s) => s.free), ...rows.filter((s) => !s.free)];
}

/** The /stores message. Kept plain so it reads the same everywhere. */
export function storesMessage() {
  const { free, keyed } = groupedStores();
  const bits = (s, extra) => {
    const parts = [];
    if (!s.perSize) parts.push("whole product, not per size");
    if (s.note) parts.push(s.note);
    if (extra) parts.push(extra);
    return parts.length ? ` — ${parts.join("; ")}` : "";
  };
  const free_ = (s) => `• ${s.name}${bits(s)}`;
  const keyed_ = (s) => `• ${s.name}${bits(s, `${s.credits} credit${s.credits === 1 ? "" : "s"} a check, every ${s.everyHours}h`)}`;
  return [
    "🏬 Shops I can track",
    "",
    "Free — just paste a link:",
    ...free.map(free_),
    "",
    "Need your own key (/setkey) — these block bots, so checks spend your credits:",
    ...keyed.map(keyed_),
    "",
    "Missing one? Send the link anyway — I'll try to read it, and log the request if I can't.",
  ].join("\n");
}
