// Unblocker fetch with COST-TIERED escalation — provider-agnostic.
//
// Phase 1 passes the *subscriber's own* key in explicitly (no process.env), and
// as of the pluggable-provider change, their chosen PROVIDER too. Betting
// onboarding on one vendor was a mistake waiting to happen: ScrapingBee's free
// credits are a one-month trial, so every user would hit a wall in week five.
//
// Escalation is unchanged in spirit:
//   render (cheapest useful) -> + premium proxies -> + hardest anti-bot mode
//
// We only climb when a tier comes back blocked, so the common case stays cheap.

import { httpGet } from "./fetcher.mjs";
import { PROVIDERS, DEFAULT_PROVIDER, buildRequestUrl } from "./providers.mjs";

const looksBlocked = (status, body) =>
  status === 403 || status === 429 || status === 401 || !body ||
  /<title>[^<]*(access denied|attention required|just a moment|server busy)/i.test(body);

/**
 * Escalate tiers until one returns a usable page.
 * @param {string} url
 * @param {{ apiKey?: string, provider?: string, country?: string, maxTier?: string }} opts
 */
export async function fetchViaUnblockerTiered(url, { apiKey, provider = DEFAULT_PROVIDER, country = "sg", maxTier } = {}) {
  if (!apiKey) return { ok: false, status: 0, body: "", mode: "none", ms: 0, error: "no unblocker key" };
  const p = PROVIDERS[provider];
  if (!p) return { ok: false, status: 0, body: "", mode: "none", ms: 0, error: `unknown provider ${provider}` };

  const ladder = maxTier ? p.tiers.slice(0, p.tiers.findIndex((t) => t.mode === maxTier) + 1) : p.tiers;

  let last = { ok: false, status: 0, body: "", mode: "none", ms: 0, error: "no tiers tried" };
  for (const tier of ladder) {
    last = await providerFetch(provider, url, apiKey, country, tier.params);
    last.mode = tier.mode;
    if (last.ok && !looksBlocked(last.status, last.body)) return last;
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
  return providerFetch(provider, url, apiKey, country, p.apiTier);
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
  const un = await fetchViaUnblockerTiered(item.url, { apiKey, provider, country });
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
