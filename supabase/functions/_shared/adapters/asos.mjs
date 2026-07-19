// ASOS adapter. Two free-of-JS JSON APIs (verified live 2026-07-03), fetched via
// the unblocker (~10cr each — premium proxy, no render):
//
//   catalogue/v4/summaries?store=ROW&country=SG&productIds=ID&expand=variants
//     -> [{ id, variants:[{ id, brandSize, sku, isAvailable }] }]   (size NAMES)
//   catalogue/v4/stockprice?productIds=ID&store=ROW&currency=SGD
//     -> [{ productPrice:{ current:{value}, previous:{value}, currency },
//           variants:[{ id, isInStock, isLowInStock }] }]           (PRICE + real-time stock)
//
// Merge by variant id. STORE MATTERS: ASOS picks currency by `store`, not geo —
// Singapore is store=ROW (a plain fetch defaults to the USD store; that's why an
// earlier scrape showed $70 vs the real SGD 94.99). The currency guard refuses a
// wrong-store response rather than mislabel it. Track a size via
// variantSelector { productId, size } where size is the brandSize ("M").

import { fetchApiViaUnblocker } from "../unblocker.mjs";

const KEY_STORE_DATAVERSION = "7qyyrb1-46"; // ASOS catalogue version; refresh if the calls start failing
const CAT = "https://www.asos.com/api/product/catalogue/v4";
const summariesUrl = (id, store, country) =>
  `${CAT}/summaries?store=${store}&keyStoreDataversion=${KEY_STORE_DATAVERSION}&productIds=${id}&lang=en-GB&expand=variants&country=${country}`;
const stockpriceUrl = (id, store, currency) =>
  `${CAT}/stockprice?productIds=${id}&store=${store}&currency=${currency}&keyStoreDataversion=${KEY_STORE_DATAVERSION}`;

/**
 * @param {any} summaries  parsed /summaries response (array)
 * @param {any} stockprice parsed /stockprice response (array)
 * @param {import("../types.mjs").Item} item
 * @returns {import("../types.mjs").ReadResult}
 */
export function parseAsos(summaries, stockprice, item) {
  const checkedAt = new Date().toISOString();
  const product = Array.isArray(summaries) ? summaries[0] : summaries;
  const priceEntry = Array.isArray(stockprice) ? stockprice[0] : stockprice;
  if (!product || !Array.isArray(product.variants) || product.variants.length === 0) {
    return { ok: false, kind: "parse", message: "asos: no summaries variants (shape changed?)", checkedAt };
  }
  if (!priceEntry || !priceEntry.productPrice) {
    return { ok: false, kind: "parse", message: "asos: no stockprice productPrice (shape changed?)", checkedAt };
  }

  const pp = priceEntry.productPrice;
  const currency = pp.currency ?? item.currency ?? "";
  if (item.currency && currency && currency !== item.currency) {
    return { ok: false, kind: "parse", message: `asos: response currency ${currency} != expected ${item.currency} (wrong store — refusing)`, checkedAt };
  }
  const price = pp.current?.value != null ? Number(pp.current.value) : undefined;
  const previous = pp.previous?.value != null ? Number(pp.previous.value) : undefined;
  const compareAt = previous != null && price != null && previous > price ? previous : undefined;
  const stockById = new Map((priceEntry.variants ?? []).map((v) => [String(v.id), v]));

  const variants = product.variants.map((v) => {
    const st = stockById.get(String(v.id)) ?? {};
    return {
      id: String(v.id),
      label: String(v.brandSize ?? v.displaySizeText ?? v.id),
      price,
      compareAtPrice: compareAt,
      available: st.isInStock === true,
      sizeCode: v.brandSize != null ? String(v.brandSize) : undefined,
    };
  });

  const sel = item.variantSelector ?? {};
  const wants = sel.size != null;
  const chosen = wants
    ? variants.find((v) => v.sizeCode === String(sel.size))
    : item.variantId ? variants.find((v) => v.id === String(item.variantId)) : undefined;
  if (wants && !chosen) {
    return { ok: false, kind: "parse", message: `asos: size ${sel.size} not found in variants`, checkedAt };
  }

  const available = chosen ? chosen.available : variants.some((v) => v.available);
  return { ok: true, price: chosen?.price ?? price, currency, compareAtPrice: compareAt, available, variants, checkedAt };
}

/** @param {import("../types.mjs").Item} item */
export async function readAsos(item, ctx = {}) {
  const checkedAt = new Date().toISOString();
  const sel = item.variantSelector ?? {};
  const id = sel.productId ?? (item.url.match(/\/prd\/(\d+)/) || [])[1];
  if (!id) return { ok: false, kind: "parse", message: "asos: no productId (set variantSelector.productId or use a /prd/ URL)", checkedAt };
  const store = sel.store ?? "ROW";
  const country = sel.country ?? "SG";
  const currency = item.currency ?? "SGD";

  const [sm, sp] = await Promise.all([
    fetchApiViaUnblocker(summariesUrl(id, store, country), { apiKey: ctx.unblockerKey }),
    fetchApiViaUnblocker(stockpriceUrl(id, store, currency), { apiKey: ctx.unblockerKey }),
  ]);
  const bad = !sm.ok ? sm : !sp.ok ? sp : null;
  if (bad) {
    const kind = bad.status === 403 ? "blocked" : bad.error === "timeout" ? "timeout" : "http";
    return { ok: false, kind, status: bad.status, message: `asos api failed (${bad.status || bad.error})`, checkedAt };
  }
  let summaries, stockprice;
  try {
    summaries = JSON.parse(sm.body);
    stockprice = JSON.parse(sp.body);
  } catch {
    return { ok: false, kind: "parse", message: "asos api did not return JSON (blocked or key stale?)", checkedAt };
  }
  return parseAsos(summaries, stockprice, item);
}
