// Unblocker fetch with COST-TIERED escalation — Phase 1 (bring-your-own-key).
//
// Unlike Phase 0 (a single global env key), Phase 1 passes the *subscriber's own*
// ScrapingBee key in explicitly. No process.env / Deno.env here: callers thread
// `apiKey` down, so this module stays pure and portable.
//
//   render_js (~5cr) -> render + premium_proxy (~25cr) -> + stealth (~75cr)
//
// Defended sites are checked daily and capped per user (see policy), so a user's
// free tier goes a long way.

import { httpGet } from "./fetcher.mjs";

const TIERS = [
  { mode: "render", params: { render_js: "true" } },
  { mode: "premium", params: { render_js: "true", premium_proxy: "true" } },
  { mode: "stealth", params: { render_js: "true", stealth_proxy: "true" } },
];

const looksBlocked = (status, body) =>
  status === 403 || status === 429 || status === 401 || !body ||
  /<title>[^<]*(access denied|attention required|just a moment)/i.test(body);

/**
 * Escalate tiers until one returns a usable page.
 * @param {string} url
 * @param {{ apiKey?: string, country?: string, maxTier?: "render"|"premium"|"stealth" }} opts
 */
export async function fetchViaUnblockerTiered(url, { apiKey, country = "sg", maxTier } = {}) {
  if (!apiKey) return { ok: false, status: 0, body: "", mode: "none", ms: 0, error: "no unblocker key" };
  const ladder = maxTier ? TIERS.slice(0, TIERS.findIndex((t) => t.mode === maxTier) + 1) : TIERS;

  let last = { ok: false, status: 0, body: "", mode: "none", ms: 0, error: "no tiers tried" };
  for (const tier of ladder) {
    last = await scrapingbeeFetch(url, apiKey, { ...tier.params, country });
    last.mode = tier.mode;
    if (last.ok && !looksBlocked(last.status, last.body)) return last;
  }
  return last;
}

/**
 * Fetch a JSON API through the unblocker WITHOUT JS rendering (cheaper).
 * @param {string} url
 * @param {{ apiKey?: string, country?: string }} opts
 */
export async function fetchApiViaUnblocker(url, { apiKey, country = "sg" } = {}) {
  if (!apiKey) return { ok: false, status: 0, body: "", error: "no unblocker key" };
  const params = new URLSearchParams({ api_key: apiKey, url, render_js: "false", premium_proxy: "true" });
  if (country) params.set("country_code", country);
  try {
    const r = await fetch(`https://app.scrapingbee.com/api/v1/?${params.toString()}`);
    const body = await r.text();
    return { ok: r.ok, status: r.status, body, cost: Number(r.headers.get("spb-cost") ?? 0) || undefined };
  } catch (e) {
    return { ok: false, status: 0, body: "", error: String(e?.message ?? e) };
  }
}

/**
 * Direct fetch first (free); escalate to the unblocker when the page is blocked
 * OR returns a 200 shell that lacks the data (`validate`).
 * @param {import("./types.mjs").Item} item
 * @param {{ apiKey?: string, country?: string, validate?: (html:string)=>boolean }} opts
 */
export async function fetchMaybeUnblocked(item, { apiKey, country = "sg", validate } = {}) {
  const direct = await httpGet(item.url, { headers: { accept: "text/html" } });
  const clean = direct.ok && !/captcha|are you human|access denied/i.test(direct.body);
  if (clean && (!validate || validate(direct.body))) {
    return { ok: true, html: direct.body, via: "direct", status: direct.status };
  }
  if (!apiKey) {
    return { ok: false, via: "direct", status: direct.status, error: direct.error, message: `direct unusable (${direct.status || direct.error}${clean ? "; shell/needs render" : ""}) and no unblocker key on this subscription` };
  }
  const un = await fetchViaUnblockerTiered(item.url, { apiKey, country });
  if (!un.ok) return { ok: false, via: `unblocker:${un.mode}`, status: un.status, error: un.error, message: `unblocker failed (${un.status || un.error}) at mode=${un.mode}` };
  return { ok: true, html: un.body, via: `unblocker:${un.mode}`, status: un.status };
}

async function scrapingbeeFetch(url, key, { country, ...extra }) {
  const params = new URLSearchParams({ api_key: key, url, ...extra });
  if (country) params.set("country_code", country);
  const started = Date.now();
  try {
    const res = await fetch(`https://app.scrapingbee.com/api/v1/?${params.toString()}`);
    const body = await res.text();
    const cost = Number(res.headers.get("spb-cost") ?? 0) || undefined;
    return { ok: res.ok, status: res.status, body, cost, ms: Date.now() - started, mode: "" };
  } catch (e) {
    return { ok: false, status: 0, body: "", ms: Date.now() - started, mode: "", error: String(e?.message ?? e) };
  }
}
