// Cettire.
//
// No JSON-LD at all. It's a Reaction Commerce storefront on Next.js, and the
// whole catalogue state rides in a `__NEXT_DATA__` assignment as a normalised
// Apollo cache. Good news: that cache carries a REAL INVENTORY COUNT
// (`inventoryAvailableToSell`) alongside the sold-out flags, which is better
// stock data than most stores give us.
//
// COST, measured 2026-07-26 from Scrape.do's own scrape.do-request-cost header:
// the cheapest PLAIN mode still returns the full state — but it is billed TEN
// credits, where the identical mode against ebay.com is billed one. Scrape.do
// prices some domains above the mode, so "which tier worked" is not the same
// question as "what did it cost", and only the header answers the second.
// Hence ADAPTER_TIER.cettire = "super" and a daily cadence: the quote a user
// sees at /add has to be the real number.
//
// (A first probe that validated on JSON-LD — which this site never emits —
// also escalated pointlessly to super_render. A gate that asks for the wrong
// marker doesn't merely fail; it burns credits climbing tiers.)
//
// SCOPING, the thing to get right: the page's Apollo store holds entries for
// related products too, so "the first variant found" is the eBay-carousel bug
// waiting to happen. The product URL's last path segment is a base64 token
// (`cmVhY3Rpb24vcHJvZHVjdDpKYTZ4…` = "reaction/product:Ja6x…") and each variant
// repeats it in its `variantId` field, so we match on that and read nothing else.

import { fetchMaybeUnblocked } from "../unblocker.mjs";
import { STATE, isBuyable } from "../stock.mjs";
import { decodeEntities } from "../text.mjs";

/** The base64 product token from …/products/{slug}/{token}. */
export function productTokenOf(url) {
  const m = String(url).match(/\/products\/[^/]+\/([^/?#]+)/);
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch { return m[1]; }
}

/**
 * Pull the first balanced JSON object following a marker. `__NEXT_DATA__` is an
 * assignment inside a normal <script>, so there's no tag boundary to lean on and
 * a non-greedy regex truncates it half a megabyte in.
 */
export function jsonAfter(source, marker) {
  const s = String(source);
  const at = s.indexOf(marker);
  if (at < 0) return null;
  const start = s.indexOf("{", at);
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let p = start; p < s.length; p++) {
    const c = s[p];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") { depth--; if (!depth) return s.slice(start, p + 1); }
  }
  return null;
}

/** Cettire tells us both a quantity and a set of flags. Believe the QUANTITY. */
export function stateFromCettire(v) {
  if (v?.isSoldOut === true) return STATE.OUT_OF_STOCK;
  const qty = Number(v?.inventoryAvailableToSell);
  if (Number.isFinite(qty)) {
    // A store that says "in stock" next to a zero count is describing a page,
    // not a warehouse — we shipped a sold-out item as available once by
    // trusting a status field over its quantity.
    if (qty <= 0) return STATE.OUT_OF_STOCK;
    if (v?.isLowQuantity === true || qty <= 2) return STATE.LOW_STOCK;
    return STATE.IN_STOCK;
  }
  if (v?.isLowQuantity === true) return STATE.LOW_STOCK;
  return null; // unknown shape — the caller turns this into a soft failure
}

/** The marker the fetch gate needs: the Apollo state actually rendered. */
export function hasCatalogState(html) {
  return /inventoryAvailableToSell/.test(String(html));
}

/**
 * @param {string} html
 * @param {import("../types.mjs").Item} item
 * @returns {import("../types.mjs").ReadResult}
 */
export function parseCettire(html, item) {
  const checkedAt = new Date().toISOString();

  const raw = jsonAfter(html, "__NEXT_DATA__");
  if (!raw) {
    return { ok: false, kind: "parse", message: "cettire: no __NEXT_DATA__ state (page shape changed or not rendered)", checkedAt };
  }
  let data;
  try { data = JSON.parse(raw); } catch {
    return { ok: false, kind: "parse", message: "cettire: __NEXT_DATA__ was not valid JSON", checkedAt };
  }
  const apollo = data?.props?.pageProps?.apolloState ?? data?.props?.apolloState;
  const store = apollo?.data ?? apollo;
  if (!store || typeof store !== "object") {
    return { ok: false, kind: "parse", message: "cettire: no apollo state in __NEXT_DATA__", checkedAt };
  }

  const token = item.variantSelector?.token ?? productTokenOf(item.url);
  if (!token) {
    return { ok: false, kind: "parse", message: "cettire: no product token in that link", checkedAt };
  }

  const real = (k) => !k.startsWith("$"); // Apollo's field-level cache keys aren't entities
  const isVariant = (e) => e?.inventoryAvailableToSell !== undefined;

  // WHICH PRODUCT IS OURS. Every SIZE is its own variant with its own token, so
  // matching variants on the URL's token finds exactly one — which looked right
  // on a one-size bag and silently dropped 29 of 30 sizes on a sneaker. The
  // authoritative link is CatalogProduct.variants[], a list of refs into this
  // same store; the URL's token just tells us which product owns them.
  const products = Object.keys(store).filter((k) => real(k) && store[k]?.__typename === "CatalogProduct");
  const tokenVariantKey = Object.keys(store).find((k) => real(k) && isVariant(store[k]) && store[k].variantId === token);
  const refsOf = (pk) => (Array.isArray(store[pk]?.variants) ? store[pk].variants : []).map((r) => r?.id ?? r);

  let productKey = tokenVariantKey
    ? products.find((pk) => refsOf(pk).includes(tokenVariantKey))
    : undefined;
  productKey ??= products.length === 1 ? products[0] : undefined;

  // Resolve the product's own variants; fall back to the single token match if
  // the product entry is missing, so a shape change degrades rather than breaks.
  let keys = productKey ? refsOf(productKey).filter((k) => store[k] && isVariant(store[k])) : [];
  if (!keys.length && tokenVariantKey) keys = [tokenVariantKey];
  if (!keys.length) {
    return { ok: false, kind: "parse", message: "cettire: no variants matched this product (shape changed?)", checkedAt };
  }

  let currency;
  const vocab = new Set();
  const variants = [];
  for (const k of keys) {
    const v = store[k];
    const money = store[`${k}.currencyPrices.0`] ?? (Array.isArray(v.currencyPrices) ? v.currencyPrices[0] : undefined);
    const state = stateFromCettire(v);
    vocab.add(JSON.stringify({ soldOut: v.isSoldOut, low: v.isLowQuantity, qty: v.inventoryAvailableToSell }));
    if (state === null) {
      return { ok: false, kind: "parse", message: `cettire: unrecognised stock shape ${[...vocab][0]} (DO NOT trust)`, checkedAt };
    }
    const price = money?.price != null ? Number(money.price) : undefined;
    const compareAt = money?.compareAtPrice != null ? Number(money.compareAtPrice) : undefined;
    currency ??= money?.currencyCode;
    variants.push({
      id: String(v.sku ?? v._id ?? k),
      label: decodeEntities(String(v.optionTitle ?? v.title ?? "One Size")).trim(),
      price,
      compareAtPrice: compareAt && price != null && compareAt > price ? compareAt : undefined,
      available: isBuyable(state) && price != null,
      state,
      sizeCode: v.optionTitle != null ? String(v.optionTitle) : undefined,
    });
  }

  // Narrow to a chosen size, if the user picked one.
  const wanted = item.variantSelector?.size;
  const chosen = wanted ? variants.filter((v) => v.sizeCode === String(wanted)) : variants;
  if (wanted && !chosen.length) {
    return { ok: false, kind: "parse", message: `cettire: size ${wanted} is no longer listed`, checkedAt };
  }

  // Sizes are priced individually here (a sneaker ran IT35 at 220.89 and IT44 at
  // 519.51), so the headline is the cheapest one you can ACTUALLY BUY. Taking
  // the minimum across every size quotes a bargain that's sold out — the same
  // dishonesty as a false "in stock", wearing a price tag.
  const priceOf = (vs) => {
    const ps = vs.map((v) => v.price).filter((p) => typeof p === "number");
    return ps.length ? Math.min(...ps) : undefined;
  };
  const buyable = chosen.filter((v) => v.available);
  const price = priceOf(buyable) ?? priceOf(chosen);

  // Stock says buyable but no price: a half-read page, not an unbuyable item.
  if (chosen.some((v) => isBuyable(v.state)) && price == null) {
    return { ok: false, kind: "soft", message: "cettire: stock reads as live but the price is missing (partial page)", checkedAt };
  }

  const product = productKey ? store[productKey] : Object.values(store).find((e) => e?.__typename === "CatalogProduct" && e?.title);
  const title = product?.title ? decodeEntities(String(product.title)).replace(/\s+/g, " ").trim() : undefined;

  return {
    ok: true,
    price,
    currency: currency ?? item.currency ?? "USD",
    compareAtPrice: chosen.find((v) => v.compareAtPrice)?.compareAtPrice,
    available: chosen.some((v) => v.available),
    variants: chosen,
    title,
    checkedAt,
  };
}

/** @param {import("../types.mjs").Item} item */
export async function readCettire(item, ctx = {}) {
  const checkedAt = new Date().toISOString();
  if (!productTokenOf(item.url)) {
    return { ok: false, kind: "parse", message: "cettire: that link has no product id (expected /products/{name}/{id})", checkedAt };
  }

  const res = await fetchMaybeUnblocked(item, {
    apiKey: ctx.unblockerKey,
    provider: ctx.unblockerProvider,
    startTier: ctx.startTier,
    country: "sg",
    // Demand the rendered catalogue state, not merely a 200 — a challenge page
    // carries neither, and this is the one marker the parser cannot work without.
    validate: hasCatalogState,
  });
  if (!res.ok) {
    const kind = res.status === 403 ? "blocked" : res.error === "timeout" ? "timeout" : "http";
    return { ok: false, kind, status: res.status, message: `cettire: ${res.message}`, checkedAt };
  }

  const out = parseCettire(res.html, item);
  if (out.ok) { out.tier = res.tier; out.cost = res.cost; out.remaining = res.remaining; }
  return out;
}
