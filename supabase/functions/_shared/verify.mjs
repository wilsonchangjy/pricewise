// Cross-checking a reading against a second opinion before we make a claim.
//
// Our worst failure mode isn't a crash — it's a confident wrong number. An
// adapter that starts reporting a plausible-but-wrong price looks perfectly
// healthy: the checks succeed, the alerts send, and someone buys on our word.
//
// So: when a reading is about to produce a PRICE claim, read the page's own
// JSON-LD and see whether it agrees. Cost is proportional to alerts, not checks,
// which is why this is affordable at all.
//
// The subtle part is refusing to cry wolf. We have already been bitten by
// geo-localized JSON-LD (the Shopify meta.json fix exists because of it), so a
// currency mismatch is "unknown", never "disagree".

import { parseJsonLd } from "./adapters/jsonld.mjs";
import { httpGet } from "./fetcher.mjs";

/** Prices are floats from different sources; allow a cent of drift. */
const TOLERANCE_ABS = 0.02;
const TOLERANCE_PCT = 0.01; // 1% — covers rounding and tax-display differences

/**
 * @param {{price?:number, currency?:string}} ours
 * @param {{price?:number, currency?:string}} theirs
 * @returns {{status:"agree"|"disagree"|"unknown", reason?:string, observed?:number}}
 */
export function comparePrices(ours, theirs) {
  const a = Number(ours?.price);
  const b = Number(theirs?.price);
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    return { status: "unknown", reason: "no comparable price" };
  }
  // Different currencies means different stores/regions, not a wrong reading.
  const ca = (ours?.currency ?? "").toUpperCase();
  const cb = (theirs?.currency ?? "").toUpperCase();
  if (ca && cb && ca !== cb) {
    return { status: "unknown", reason: `currency differs (${ca} vs ${cb})`, observed: b };
  }

  const diff = Math.abs(a - b);
  if (diff <= TOLERANCE_ABS || diff / Math.max(a, b) <= TOLERANCE_PCT) {
    return { status: "agree", observed: b };
  }
  return { status: "disagree", reason: `we read ${a}, the page says ${b}`, observed: b };
}

/**
 * WHERE to read the second opinion from.
 *
 * It has to be the same storefront the reading came from. This used to fetch
 * product.url bare, which on a market-pinned row is a different shop wearing the
 * same name: the checker reads mutimer.co at ?country=SG and gets SGD 418, while
 * this fetched the plain URL from Supabase's datacentre IP, got geo-routed to
 * Australia, and read AUD 380. comparePrices() then did exactly what it should —
 * refused to judge across currencies — and returned "unknown" every single time:
 *
 *     verify 17: unknown (currency differs (SGD vs AUD))
 *     verify 18: unknown (currency differs (EUR vs AUD))
 *
 * So verification was silently switched OFF on precisely the rows most likely to
 * need it. Not a wrong answer, which is why nothing caught it — just a safety net
 * quietly declining to catch anything.
 *
 * ?country= is Shopify Markets' own switch and is confirmed to move the HTML
 * page's JSON-LD, not only the .js endpoint (measured: the same page reads
 * "priceCurrency": "AUD" / 380.00 bare and "SGD" / 418.00 with ?country=SG).
 * Other adapters carry a market too, but nothing says their sites take this
 * parameter, so they keep the plain URL — inventing a query string for them
 * would be guessing, and a wrong second opinion is worse than none.
 */
export function verifyUrlFor(product) {
  const market = product?.market ? String(product.market).toUpperCase() : "";
  if (!market || product?.adapter !== "shopify") return product?.url;
  try {
    const u = new URL(product.url);
    if (u.searchParams.has("country")) return u.toString(); // already pinned
    u.searchParams.set("country", market);
    return u.toString();
  } catch {
    return product.url;
  }
}

/**
 * Fetch the product page and read its JSON-LD as an independent opinion.
 * Any failure is "unknown" — an unreachable second source must never be
 * mistaken for evidence that we're wrong.
 *
 * @param {{url:string, title?:string, currency?:string, market?:string, adapter?:string}} product
 * @param {{price?:number, currency?:string}} reading
 */
export async function verifyPrice(product, reading, { fetchImpl } = {}) {
  try {
    const url = verifyUrlFor(product);
    const r = fetchImpl
      ? await fetchImpl(url)
      : await httpGet(url, { headers: { accept: "text/html" } });
    if (!r.ok) return { status: "unknown", reason: `page fetch failed (${r.status || r.error})` };

    const second = parseJsonLd(r.body, { label: product.title ?? "", url, currency: reading.currency });
    if (!second.ok) return { status: "unknown", reason: second.message };

    return comparePrices(reading, second);
  } catch (e) {
    return { status: "unknown", reason: String(e?.message ?? e) };
  }
}
