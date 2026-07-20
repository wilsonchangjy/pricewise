// Unblocker fetch with COST-TIERED escalation — provider-agnostic.
//
// Phase 1 passes the *subscriber's own* key in explicitly (no process.env), and
// as of the pluggable-provider change, their chosen PROVIDER too. Betting
// onboarding on one vendor was a mistake waiting to happen: ScrapingBee's free
// credits are a one-month trial, so every user would hit a wall in week five.
//
// The ladder opens PLAIN and climbs only when a tier comes back blocked:
//   plain -> render -> premium/super proxies -> hardest anti-bot mode
//
// Measured on Scrape.do 2026-07-21: Bershka, Stradivarius and ASOS all answer a
// plain 1-credit request; Massimo Dutti needs render (5); Zara needs super (10).
// Opening at "render" — as this did originally — overpaid 5x on the cheap three.

import { httpGet } from "./fetcher.mjs";
import { PROVIDERS, DEFAULT_PROVIDER, buildRequestUrl } from "./providers.mjs";

// A block is not always a status code. Akamai answers 200 with a tiny
// meta-refresh challenge (bm-verify), which sailed past the old title check and
// got returned as a successful read — the Phase 0 "200 shell" trap again.
const looksBlocked = (status, body) =>
  status === 403 || status === 429 || status === 401 || !body ||
  /<title>[^<]*(access denied|attention required|just a moment|server busy)/i.test(body) ||
  /bm-verify|_abck|challenge-platform|Incapsula|__cf_chl/i.test(body) ||
  (body.length < 5000 && /http-equiv=["\']?refresh/i.test(body));

/**
 * Escalate tiers until one returns a usable page.
 * @param {string} url
 * @param {{ apiKey?: string, provider?: string, country?: string, maxTier?: string }} opts
 */
export async function fetchViaUnblockerTiered(url, { apiKey, provider = DEFAULT_PROVIDER, country = "sg", maxTier, validate } = {}) {
  if (!apiKey) return { ok: false, status: 0, body: "", mode: "none", ms: 0, error: "no unblocker key" };
  const p = PROVIDERS[provider];
  if (!p) return { ok: false, status: 0, body: "", mode: "none", ms: 0, error: `unknown provider ${provider}` };

  const ladder = maxTier ? p.tiers.slice(0, p.tiers.findIndex((t) => t.mode === maxTier) + 1) : p.tiers;

  let last = { ok: false, status: 0, body: "", mode: "none", ms: 0, error: "no tiers tried" };
  for (const tier of ladder) {
    last = await providerFetch(provider, url, apiKey, country, tier.params);
    last.mode = tier.mode;
    // "Not blocked" isn't the same as "has what we came for": a cheap tier can
    // return a perfectly valid page that simply lacks the data. Keep climbing.
    const usable = last.ok && !looksBlocked(last.status, last.body)
      && (!validate || validate(last.body));
    if (usable) return last;
  }
  return last;
}

/**
 * Fetch a JSON API through the unblocker WITHOUT JS rendering (cheaper).
 * @param {string} url
 * @param {{ apiKey?: string, provider?: string, country?: string }} opts
 */
export async function fetchApiViaUnblocker(url, { apiKey, provider = DEFAULT_PROVIDER, country = "sg" } = {}) {
  if (!apiKey) return { ok: false, status: 0, body: "", error: "no unblocker key" };
  const p = PROVIDERS[provider];
  if (!p) return { ok: false, status: 0, body: "", error: `unknown provider ${provider}` };

  // Start plain: measured 2026-07-21, Bershka/Stradivarius/ASOS all answer a
  // 1-credit plain request. Only pay for proxies when plain actually fails.
  let last;
  for (const tier of p.apiTiers ?? [{}]) {
    last = await providerFetch(provider, url, apiKey, country, tier);
    if (last.ok && !looksBlocked(last.status, last.body)) return last;
  }
  return last;
}

/**
 * Direct fetch first (free); escalate to the unblocker when the page is blocked
 * OR returns a 200 shell that lacks the data (`validate`).
 * @param {import("./types.mjs").Item} item
 * @param {{ apiKey?: string, provider?: string, country?: string, validate?: (html:string)=>boolean }} opts
 */
export async function fetchMaybeUnblocked(item, { apiKey, provider = DEFAULT_PROVIDER, country = "sg", validate } = {}) {
  const direct = await httpGet(item.url, { headers: { accept: "text/html" } });
  const clean = direct.ok && !/captcha|are you human|access denied/i.test(direct.body);
  if (clean && (!validate || validate(direct.body))) {
    return { ok: true, html: direct.body, via: "direct", status: direct.status };
  }
  if (!apiKey) {
    return {
      ok: false, via: "direct", status: direct.status, error: direct.error,
      message: `direct unusable (${direct.status || direct.error}${clean ? "; shell/needs render" : ""}) and no unblocker key on this subscription`,
    };
  }
  const un = await fetchViaUnblockerTiered(item.url, { apiKey, provider, country, validate });
  if (!un.ok) {
    return {
      ok: false, via: `${provider}:${un.mode}`, status: un.status, error: un.error,
      message: `unblocker failed (${un.status || un.error}) at mode=${un.mode}`,
    };
  }
  return { ok: true, html: un.body, via: `${provider}:${un.mode}`, status: un.status };
}

async function providerFetch(provider, url, apiKey, country, tierParams) {
  const started = Date.now();
  try {
    const requestUrl = buildRequestUrl(provider, url, { apiKey, country, tier: tierParams });
    const res = await fetch(requestUrl);
    const body = await res.text();
    // Every vendor reports cost on a different header; take whichever is present.
    const cost = Number(res.headers.get("spb-cost") ?? res.headers.get("x-api-credits") ?? 0) || undefined;
    return { ok: res.ok, status: res.status, body, cost, ms: Date.now() - started, mode: "" };
  } catch (e) {
    return { ok: false, status: 0, body: "", ms: Date.now() - started, mode: "", error: String(e?.message ?? e) };
  }
}
