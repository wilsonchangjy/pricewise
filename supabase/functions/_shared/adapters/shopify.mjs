// Shopify adapter. Uses the storefront `/products/{handle}.js` endpoint, which
// (unlike `.json`) returns per-variant `available` booleans and prices in cents.
//
// parseShopifyJs() is pure (no network) so it can be unit-tested with fixtures.

import { httpGet } from "../fetcher.mjs";
import { currencyForCountry } from "../locale.mjs";

const cents = (n) => (n == null ? undefined : Number(n) / 100);

/**
 * @param {any} data  Parsed Shopify `.js` product object.
 * @param {import("../types.mjs").Item} item
 * @returns {import("../types.mjs").ReadResult}
 */
export function parseShopifyJs(data, item) {
  const checkedAt = new Date().toISOString();
  if (!data || !Array.isArray(data.variants)) {
    return { ok: false, kind: "parse", message: "shopify .js missing variants[] (wrong handle or not Shopify)", checkedAt };
  }
  const variants = data.variants.map((v) => ({
    id: String(v.id),
    label: v.title ?? v.public_title ?? "default",
    price: cents(v.price),
    compareAtPrice: cents(v.compare_at_price),
    available: v.available === true,
  }));

  const chosen = item.variantId ? variants.find((v) => v.id === String(item.variantId)) : undefined;
  const price = chosen?.price ?? cents(data.price);
  const compareAtPrice = chosen?.compareAtPrice ?? cents(data.compare_at_price);
  const available = chosen ? chosen.available : variants.some((v) => v.available);

  return {
    ok: true,
    price,
    currency: item.currency ?? "",
    compareAtPrice: compareAtPrice && price != null && compareAtPrice > price ? compareAtPrice : undefined,
    available,
    variants,
    checkedAt,
  };
}

/** @param {import("../types.mjs").Item} item */
export async function readShopify(item) {
  const checkedAt = new Date().toISOString();
  // Build the canonical /products/{handle}.js (handles /collections/.../products/ URLs).
  const u = new URL(item.url);
  const handle = (u.pathname.match(/\/products\/([^/]+)/) || [])[1];
  const base = handle ? `${u.origin}/products/${handle}.js` : item.url.split("?")[0].replace(/\/+$/, "") + ".js";

  // PIN THE MARKET. Shopify serves a different price AND different stock per
  // market, and `.js` honours ?country=. Measured on mutimer.co, one variant,
  // one moment: no hint -> 380.00 out of stock; ?country=GB -> 240.00 IN STOCK;
  // ?country=SG -> 418.00 out of stock. Without the hint the answer is whatever
  // geography the checker happens to run in — which is nobody's storefront.
  const market = item.market ? String(item.market).toUpperCase() : undefined;
  const jsUrl = market ? `${base}?country=${encodeURIComponent(market)}` : base;

  const r = await httpGet(jsUrl, { headers: { accept: "application/json" } });
  if (!r.ok) {
    const kind = r.status === 403 ? "blocked" : r.error === "timeout" ? "timeout" : "http";
    return { ok: false, kind, status: r.status, message: `shopify .js fetch failed (${r.status || r.error})`, checkedAt };
  }
  let data;
  try {
    data = JSON.parse(r.body);
  } catch {
    return { ok: false, kind: "parse", message: "shopify .js did not return JSON", checkedAt };
  }
  // CURRENCY MUST COME FROM THE SAME MARKET AS THE PRICE.
  //
  // This used to read the shop's BASE currency from /meta.json regardless of
  // which market the price came from — so an SGD number could be printed with a
  // EUR label, which is the one failure this project refuses: a real number
  // wearing the wrong denomination. When the market is pinned, its currency is
  // the market's. /meta.json is only the fallback for unpinned rows, where the
  // price really is the shop's default.
  let currency = item.currency ?? (market ? currencyForCountry(market) : undefined);
  if (!currency) {
    const meta = await httpGet(`${u.origin}/meta.json`, { headers: { accept: "application/json" } });
    try { currency = JSON.parse(meta.body).currency; } catch { /* leave undefined */ }
  }
  return parseShopifyJs(data, currency ? { ...item, currency } : item);
}

/**
 * Does this shop actually PRICE in the market we're about to pin, and in what?
 *
 * FOUND BY PROBING, and it is the difference between a right number and a
 * ruinous one. A Shopify shop silently serves its HOME market to any country it
 * has no market for — same URL, no error, no signal in the .js payload:
 *
 *   mutimer.co ?country=SG -> 417.00 SGD   (a real market)
 *   mutimer.co ?country=KR -> 447000 KRW   (a real market)
 *   mutimer.co ?country=IN -> 380.00 AUD   (NO market — the AU price, unchanged)
 *   mutimer.co ?country=NO -> 345.45 AUD   (NO market — a converted display price)
 *
 * currencyForCountry() would have labelled those last two INR and NOK. "INR 380"
 * for a jacket costing 380 AUD is off by about 25x, and it is exactly the kind
 * of confident wrong number this project exists not to produce.
 *
 * /meta.json cannot answer: it returns the shop's BASE currency whatever
 * ?country= says (verified — AUD for both SG and IN). ships_to_countries cannot
 * either: Norway ships and is still priced in AUD, so shipping is not a market.
 * The page's own priceCurrency is the only authoritative signal, so we ask it.
 *
 * Called at PIN time only — once when a market is chosen, never per check.
 *
 * @returns {Promise<{ currency?: string, honoured?: boolean }>}
 *   `honoured` false means the shop has no market there and served its own.
 *   An unreachable shop returns {} — unknown, and the caller must not guess.
 */
export async function probeMarketCurrency(url, market) {
  const cc = market ? String(market).toUpperCase() : "";
  if (!cc) return {};
  const expected = currencyForCountry(cc);
  try {
    const u = new URL(url);
    u.searchParams.set("country", cc);
    const r = await httpGet(u.toString(), { headers: { accept: "text/html" } });
    if (!r.ok) return {};
    const m = String(r.body).match(/"priceCurrency"\s*:\s*"([A-Z]{3})"/);
    if (!m) return {};
    const currency = m[1];
    return { currency, honoured: Boolean(expected) && currency === expected };
  } catch {
    return {};
  }
}
