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
 * Each provider maps our escalation ladder onto its own parameters. The ladder
 * starts PLAIN because measurement beat assumption: Bershka, Stradivarius and
 * ASOS all return usable data on a 1-credit plain request, where the old ladder
 * opened at render (5 credits) and the API path forced a super proxy (10).
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
    keyPattern: /^[A-Za-z0-9]{60,}$/, // observed: 80 alphanumeric
    costHeader: "spb-cost",
    remainingHeader: null, // ScrapingBee reports cost per call, not a balance
    tiers: [
      { mode: "plain", params: {} },
      { mode: "render", params: { render_js: "true" } },
      { mode: "premium", params: { render_js: "true", premium_proxy: "true" } },
      { mode: "stealth", params: { render_js: "true", stealth_proxy: "true" } },
    ],
    apiTiers: [{}, { premium_proxy: "true" }],
  },

  scraperapi: {
    label: "ScraperAPI",
    signup: "https://www.scraperapi.com",
    // Corrected 2026-07-21: their free credits are a TRIAL, not a monthly tier.
    // I had taken a search-result snippet at face value instead of the pricing page.
    freeNote: "trial credits only — does not renew",
    verified: false,
    hidden: true, // no free tier and untested by us: nothing to recommend
    base: "https://api.scraperapi.com/",
    keyParam: "api_key",
    urlParam: "url",
    countryParam: "country_code",
    keyPattern: /^[a-f0-9]{32}$/i,
    costHeader: null,
    remainingHeader: null,
    tiers: [
      { mode: "plain", params: {} },
      { mode: "render", params: { render: "true" } },
      { mode: "premium", params: { render: "true", premium: "true" } },
      { mode: "stealth", params: { render: "true", ultra_premium: "true" } },
    ],
    apiTiers: [{}, { premium: "true" }],
  },

  scrapedo: {
    label: "Scrape.do",
    signup: "https://scrape.do",
    freeNote: "1,000 credits every month — renews (confirmed on their pricing page)",
    // Verified 2026-07-21 against every defended brand we support.
    verified: true,
    base: "https://api.scrape.do/",
    keyParam: "token",
    urlParam: "url",
    countryParam: "geoCode",
    keyPattern: /^[A-Za-z0-9]{32,55}$/, // observed: 43 alphanumeric
    // Every response carries the balance — so a user's real quota is observable
    // for free, and we never have to guess what plan they're on.
    costHeader: "scrape.do-request-cost",
    remainingHeader: "scrape.do-remaining-credits",
    // Measured costs: plain 1, render 5, super 10.
    tiers: [
      { mode: "plain", params: {} },
      { mode: "render", params: { render: "true" } },
      { mode: "super", params: { super: "true" } },
      { mode: "super_render", params: { render: "true", super: "true" } },
    ],
    apiTiers: [{}, { super: "true" }],
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
export function providerSummary({ includeHidden = false } = {}) {
  return Object.entries(PROVIDERS)
    .filter(([, p]) => includeHidden || !p.hidden)
    .map(([id, p]) => ({
      id, label: p.label, signup: p.signup, freeNote: p.freeNote, verified: p.verified,
    }));
}

/**
 * Step-by-step for someone who has never set up a key — the first thing anyone
 * whose items are held or blocked needs, and until now only reachable as a
 * vendor list (/providers) with no instructions.
 *
 * Scrape.do is the one recommended: its free credits renew monthly and it is
 * tested end to end. The command NAMES the provider on purpose — a Scrape.do key
 * has the same shape as a ScraperAPI one, so a bare "/setkey <key>" is answered
 * with "I can't tell which service that key is for", which is a terrible first
 * experience for the exact person this guide is for.
 *
 * @param {{ heldCount?: number }} [opts]  items currently waiting on a key
 */
export function keySetupGuide({ heldCount = 0 } = {}) {
  const p = PROVIDERS.scrapedo;
  return [
    "🔑 Setting up an unblocker key (about 2 minutes, free)",
    "",
    "Some shops refuse my server, either because they block bots or because they're",
    "rate-limiting the shared address I run on. An unblocker key lets me fetch through",
    "a service that gets through. It's your own account, so you control what it spends.",
    "",
    `1. Sign up at ${p.signup}. The free plan is enough.`,
    "2. Your API token is created automatically. Copy it from your Scrape.do dashboard.",
    "3. Send it to me here, with the word scrapedo in front:",
    "     /setkey scrapedo YOUR_TOKEN",
    "   I delete that message as soon as I've read it, and store the key encrypted.",
    "",
    "The free plan gives 1,000 credits a month and renews. Most checks cost 1 credit,",
    "a few heavily protected shops cost more. I tell you the cost before you add one,",
    "and warn you when the balance is running low.",
    ...(heldCount > 0
      ? ["", `As soon as the key is in, I'll retry your ${heldCount} held item${heldCount === 1 ? "" : "s"} straight away.`]
      : []),
    "",
    "Other services work too: /providers lists them.",
  ].join("\n");
}
