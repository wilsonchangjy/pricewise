// END. (endclothing.com)
//
// The rare good citizen: a PLAIN DIRECT FETCH returns the whole page — HTTP 200
// from a datacentre IP, no unblocker, no credits — and it prices in the local
// currency (SGD on /sg/, unlike MR PORTER and NET-A-PORTER, which bill in GBP
// and USD there). So this is a FREE store, and users need no key for it.
//
// Data lives in a Next.js payload at props.initialProps.pageProps.product, in a
// proper <script id="__NEXT_DATA__" type="application/json">, so it's tag-bounded
// (unlike Cettire's bare assignment, which needs brace-balancing).
//
// ⚠️ THE ONE THING TO KNOW — END OMITS SOLD-OUT SIZES ENTIRELY.
// There is no in_stock:false anywhere: a size that can't be bought simply isn't
// in the data. Measured on a sale sneaker whose run reads "UK 4, UK 6, UK 7,
// 7.5, 8…" — UK 5, 5.5 and 6.5 are absent, not flagged, and the page carries no
// "sold out" or "notify me" text at all.
//
// That inverts how availability is read here: PRESENCE is the signal. It still
// delivers the thing this bot exists for — a size you're watching that vanishes
// is sold out, and one that reappears is a restock — but it costs us the ability
// to LIST a currently-sold-out size at /add, because we cannot see it.

import { httpGet } from "../fetcher.mjs";
import { STATE } from "../stock.mjs";
import { decodeEntities } from "../text.mjs";
import { localeFromUrl } from "../locale.mjs";
import { landedElsewhere, landedElsewhereResult } from "../landed.mjs";

/**
 * What currency is this page priced in? Ask the page first — END publishes
 * priceCurrency in its markup ("USD" on /us/, "SGD" on /sg/, verified live) —
 * and fall back to the country in the URL. Never assume: a wrong currency label
 * is worse than no price, because it looks like an answer.
 */
function currencyOf(html, url) {
  const m = String(html).match(/"(?:priceCurrency|currencyCode|currency)"\s*:\s*"([A-Z]{3})"/);
  return m?.[1] ?? localeFromUrl(url).currency;
}

/** The Next.js payload, which here is a real tag-bounded JSON script. */
export function nextDataOf(html) {
  const m = String(html).match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i)
    ?? String(html).match(/__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

/** The marker the fetch gate needs: the product actually rendered. */
export function hasProductState(html) {
  return /"pageProps"/.test(String(html)) && /"configurable_product_options"|"options"/.test(String(html));
}

const sizeGroup = (groups) =>
  (Array.isArray(groups) ? groups : []).find((o) => /size/i.test(String(o?.label ?? ""))) ?? null;

/**
 * @param {string} html
 * @param {import("../types.mjs").Item} item
 * @returns {import("../types.mjs").ReadResult}
 */
export function parseEnd(html, item) {
  const checkedAt = new Date().toISOString();

  const data = nextDataOf(html);
  if (!data) {
    return { ok: false, kind: "parse", message: "end: no __NEXT_DATA__ payload (page shape changed or not rendered)", checkedAt };
  }
  const p = data?.props?.initialProps?.pageProps?.product ?? data?.props?.pageProps?.product;
  if (!p || typeof p !== "object") {
    return { ok: false, kind: "parse", message: "end: no product in the page payload", checkedAt };
  }

  const price = p.price != null ? Number(p.price) : undefined;
  const title = p.name ? decodeEntities(String(p.name)).replace(/\s+/g, " ").trim() : undefined;

  // `options` carries the buyable sizes; `configurable_product_options` is the
  // same list on every page we've measured, but read both and take the union so
  // that if END ever DOES publish a fuller run, sold-out sizes start appearing
  // rather than being silently dropped.
  const buyable = sizeGroup(p.options)?.values ?? [];
  const full = sizeGroup(p.configurable_product_options)?.values ?? [];

  const buyableLabels = new Map();
  for (const v of buyable) {
    if (v?.label == null) continue;
    // in_stock is present here and always true; treat a false as authoritative.
    if (v.in_stock === false) continue;
    buyableLabels.set(String(v.label), v);
  }

  const seen = new Map();
  for (const v of [...full, ...buyable]) {
    if (v?.label == null) continue;
    const label = String(v.label);
    if (!seen.has(label)) seen.set(label, v);
  }

  let variants = [...seen.entries()].map(([label, v]) => {
    const available = buyableLabels.has(label);
    return {
      id: String(v.simple_id ?? v.index ?? label),
      label,
      price,
      available,
      state: available ? STATE.IN_STOCK : STATE.OUT_OF_STOCK,
      sizeCode: label,
    };
  });

  // A one-size product (no size option group at all) still deserves a reading.
  if (!variants.length) {
    const inStock = p.in_stock === true || p.is_salable === true;
    variants = [{
      id: String(p.sku ?? p.id ?? "default"),
      label: "One size",
      price,
      available: inStock,
      state: inStock ? STATE.IN_STOCK : STATE.OUT_OF_STOCK,
    }];
  }

  // A size the user tracks that has VANISHED is sold out, not a broken page —
  // that's precisely the alert they're waiting on. Only trust that reading when
  // the page is otherwise healthy (we did find a size list).
  const wanted = item.variantSelector?.size;
  let chosen = variants;
  if (wanted != null) {
    const hit = variants.find((v) => v.sizeCode === String(wanted));
    chosen = hit
      ? [hit]
      : [{ id: String(wanted), label: String(wanted), price, available: false, state: STATE.OUT_OF_STOCK, sizeCode: String(wanted) }];
  }

  if (price == null) {
    return { ok: false, kind: "soft", message: "end: no price on the product payload (partial page)", checkedAt };
  }

  return {
    ok: true,
    price,
    // END runs one site per country and prices each in ITS currency: the /us/
    // page is USD, /sg/ is SGD. This used to be hardcoded "SGD", which was true
    // of the page it was written against and false everywhere else — the search
    // surfaced the /us/ page and we labelled $705 as "SGD 705". The page itself
    // publishes priceCurrency, so read it; the URL's locale is the fallback.
    currency: item.currency ?? currencyOf(html, item.url) ?? "SGD",
    available: chosen.some((v) => v.available),
    variants: chosen,
    title,
    checkedAt,
  };
}

/** @param {import("../types.mjs").Item} item */
export async function readEnd(item) {
  const checkedAt = new Date().toISOString();
  const r = await httpGet(item.url, { headers: { accept: "text/html" } });
  if (!r.ok) {
    const kind = r.status === 403 ? "blocked" : r.error === "timeout" ? "timeout" : "http";
    return { ok: false, kind, status: r.status, message: `end: page fetch failed (${r.status || r.error})`, checkedAt };
  }
  if (!hasProductState(r.body)) {
    return { ok: false, kind: "soft", message: "end: page returned without its product payload", checkedAt };
  }
  // END runs a site per country and redirects between them. A redirect that
  // keeps the product slug is fine (same boot, local price — that's what we
  // want); one that drops it means we're on a listing or another product.
  const off = landedElsewhere({ requestedUrl: item.url, html: r.body, finalUrl: r.url });
  if (off.away) return landedElsewhereResult("end", off.landedOn, checkedAt);
  return parseEnd(r.body, item);
}
