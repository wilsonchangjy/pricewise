// Unblocker providers.
//
// Betting the onboarding on one vendor's free tier was a mistake waiting to
// happen: ScrapingBee's 1,000 credits are a one-month TRIAL, so every user would
// hit a wall in week five. Providers are pluggable so a pricing change at any one
// of them is a config choice, not a broken product.
//
// ⚠️ HONESTY NOTE: only `scrapingbee` has been exercised against real sites by us
// (the whole defended-site spike ran on it). The others are implemented from
// their published request shapes and are UNVERIFIED — we hold no keys for them.
// They're wired so a wrong guess fails loudly at /setkey rather than silently at
// 3am during a check.

/**
 * Each provider maps our three escalation tiers onto its own parameters.
 * Tier meanings, consistent across vendors:
 *   render  — execute JS, cheapest useful tier
 *   premium — + better/residential proxies
 *   stealth — + the vendor's hardest anti-bot mode
 */
export const PROVIDERS = {
  scrapingbee: {
    label: "ScrapingBee",
    signup: "https://www.scrapingbee.com",
    freeNote: "1,000 credits — one-time trial, does not renew",
    verified: true,
    base: "https://app.scrapingbee.com/api/v1/",
    keyParam: "api_key",
    urlParam: "url",
    countryParam: "country_code",
    // ScrapingBee keys are long and alphanumeric.
    keyPattern: /^[A-Za-z0-9]{40,}$/,
    tiers: [
      { mode: "render", params: { render_js: "true" } },
      { mode: "premium", params: { render_js: "true", premium_proxy: "true" } },
      { mode: "stealth", params: { render_js: "true", stealth_proxy: "true" } },
    ],
    apiTier: { render_js: "false", premium_proxy: "true" },
  },

  scraperapi: {
    label: "ScraperAPI",
    signup: "https://www.scraperapi.com",
    freeNote: "1,000 credits every month — renews",
    verified: false,
    base: "https://api.scraperapi.com/",
    keyParam: "api_key",
    urlParam: "url",
    countryParam: "country_code",
    keyPattern: /^[a-f0-9]{32}$/i,
    tiers: [
      { mode: "render", params: { render: "true" } },
      { mode: "premium", params: { render: "true", premium: "true" } },
      { mode: "stealth", params: { render: "true", ultra_premium: "true" } },
    ],
    apiTier: { render: "false", premium: "true" },
  },

  scrapedo: {
    label: "Scrape.do",
    signup: "https://scrape.do",
    freeNote: "1,000 requests every month — renews",
    verified: false,
    base: "https://api.scrape.do/",
    keyParam: "token",
    urlParam: "url",
    countryParam: "geoCode",
    keyPattern: /^[a-f0-9]{32}$/i, // exactly 32 hex — a longer alnum key is someone else's
    tiers: [
      { mode: "render", params: { render: "true" } },
      { mode: "premium", params: { render: "true", super: "true" } },
      { mode: "stealth", params: { render: "true", super: "true", geoCode: "sg" } },
    ],
    apiTier: { render: "false", super: "true" },
  },
};

export const DEFAULT_PROVIDER = "scrapingbee";

/** Accepts "ScrapingBee", "scraping-bee", "scrape.do"… */
export function normalizeProvider(word) {
  const w = String(word ?? "").toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return null;
  if (w === "scrapingbee" || w === "bee") return "scrapingbee";
  if (w === "scraperapi" || w === "scraper") return "scraperapi";
  if (w === "scrapedo" || w === "do") return "scrapedo";
  return PROVIDERS[w] ? w : null;
}

/**
 * Guess the provider from a key's shape. ScraperAPI and Scrape.do keys are both
 * 32-char hex, so an ambiguous key returns null and the bot ASKS rather than
 * picking one — a wrong guess would send every request to the wrong vendor.
 */
export function detectProvider(key) {
  const k = String(key ?? "").trim();
  const matches = Object.entries(PROVIDERS).filter(([, p]) => p.keyPattern.test(k));
  return matches.length === 1 ? matches[0][0] : null;
}

/**
 * Build a request URL for a provider at a given tier.
 * @param {string} providerId
 * @param {string} target        the page we actually want
 * @param {{ apiKey:string, country?:string, tier?:object }} opts
 */
export function buildRequestUrl(providerId, target, { apiKey, country, tier = {} }) {
  const p = PROVIDERS[providerId];
  if (!p) throw new Error(`unknown unblocker provider: ${providerId}`);

  const params = new URLSearchParams({
    [p.keyParam]: apiKey,
    [p.urlParam]: target,
    ...tier,
  });
  // A tier may pin its own geo (Scrape.do's stealth does); don't overwrite it.
  if (country && !params.has(p.countryParam)) params.set(p.countryParam, country);
  return `${p.base}?${params.toString()}`;
}

/** For /providers — what a user needs to choose one. */
export function providerSummary() {
  return Object.entries(PROVIDERS).map(([id, p]) => ({
    id, label: p.label, signup: p.signup, freeNote: p.freeNote, verified: p.verified,
  }));
}
