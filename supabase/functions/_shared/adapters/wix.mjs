// Wix Stores adapter. Wix has no clean product API (its Stores API needs the
// site's private tokens) and its JSON-LD often omits offers — but the product
// model IS server-rendered into the page under a state key:
//
//   ..."catalog":{"product":{ ..., isInStock, price, comparePrice, currency,
//                             inventory:{status}, isManageProductItems, productItems }}
//
// Wix sites are lightly defended (direct fetch = 200, FREE).
//
// PER-SIZE: managed-variant products carry productItems[] (one per size, each
// with its own price and inventory) plus options[] mapping selection ids to
// labels. Reading only the product level said "available" for a top whose L/XL
// and 2/3X were both at quantity zero — the wedge, missed, on exactly the indie
// stores Wix is popular with.

import { httpGet } from "../fetcher.mjs";
import { STATE, isBuyable } from "../stock.mjs";

// Balanced-brace extract from the "{" at `start` (string-aware).
function balancedObject(s, start) {
  let depth = 0, inStr = false, q = "";
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (c === "\\") { i++; continue; } if (c === q) inStr = false; continue; }
    if (c === '"' || c === "'") { inStr = true; q = c; continue; }
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return s.slice(start, i + 1); }
  }
  return null;
}

/**
 * @param {string} html
 * @param {import("../types.mjs").Item} item
 * @returns {import("../types.mjs").ReadResult}
 */
export function parseWix(html, item) {
  const checkedAt = new Date().toISOString();
  const anchor = html.indexOf('"catalog":{"product":{');
  if (anchor < 0) {
    return { ok: false, kind: "parse", message: "wix: no catalog.product in page (shape changed or not a Wix Stores product)", checkedAt };
  }
  const start = html.indexOf("{", anchor + '"catalog":{'.length);
  const raw = balancedObject(html, start);
  let p;
  try { p = JSON.parse(raw); } catch { return { ok: false, kind: "parse", message: "wix: catalog.product was not valid JSON", checkedAt }; }

  const price = p.discountedPrice != null ? Number(p.discountedPrice) : p.price != null ? Number(p.price) : undefined;
  const compareRaw = p.comparePrice != null ? Number(p.comparePrice) : undefined;
  const compareAtPrice = compareRaw && price != null && compareRaw > price ? compareRaw : undefined;
  const currency = p.currency ?? item.currency ?? "";

  const variants = perSizeVariants(p);
  if (variants.length) {
    const chosen = item.variantId ? variants.find((v) => v.id === String(item.variantId)) : undefined;
    return {
      ok: true,
      price: chosen?.price ?? price ?? variants.find((v) => v.price != null)?.price,
      currency,
      compareAtPrice,
      available: chosen ? chosen.available : variants.some((v) => v.available),
      variants,
      checkedAt,
    };
  }

  // Single-variant product: the shop sells one thing, so the product IS the variant.
  //
  // Wix can report inventory.status "in_stock" while quantity is 0 and isInStock
  // is false — trusting status alone told us a sold-out item was available.
  // Quantity wins where present; isInStock breaks the tie.
  const qty = p.inventory?.quantity;
  const available = typeof qty === "number"
    ? qty > 0
    : p.isInStock === true || p.inventory?.status === "in_stock";
  return {
    ok: true,
    price,
    currency,
    compareAtPrice,
    available,
    variants: [{ id: "default", label: String(p.name ?? item.label), price, available, state: available ? STATE.IN_STOCK : STATE.OUT_OF_STOCK }],
    checkedAt,
  };
}

/**
 * One entry per size, from productItems[] + the options[] label map.
 * Returns [] when the product has no managed variants.
 */
function perSizeVariants(p) {
  const items = Array.isArray(p.productItems) ? p.productItems : [];
  if (!items.length) return [];

  // selection id -> human label ("XS", "S/M"), flattened across every option group
  const labels = new Map();
  for (const opt of p.options ?? []) {
    for (const sel of opt.selections ?? []) labels.set(sel.id, sel.value ?? sel.description ?? String(sel.id));
  }

  return items.map((it) => {
    const label = (it.optionsSelections ?? []).map((id) => labels.get(id) ?? String(id)).join(" / ");
    const qty = it.inventory?.quantity;
    const status = it.inventory?.status;
    // Quantity is authoritative when the shop tracks it; otherwise fall back to
    // the status. Hidden items are never buyable whatever the numbers say.
    const inStock = it.isVisible !== false
      && (typeof qty === "number" ? qty > 0 : status !== "out_of_stock");
    const state = inStock ? STATE.IN_STOCK : STATE.OUT_OF_STOCK;
    return {
      id: String(it.id),
      label: label || String(it.sku ?? it.id),
      price: it.price != null ? Number(it.price) : undefined,
      compareAtPrice: it.comparePrice > 0 && it.comparePrice > it.price ? Number(it.comparePrice) : undefined,
      available: isBuyable(state),
      state,
      sizeCode: label || undefined,
    };
  });
}

/** @param {import("../types.mjs").Item} item */
export async function readWix(item) {
  const checkedAt = new Date().toISOString();
  const r = await httpGet(item.url, { headers: { accept: "text/html" } });
  if (!r.ok) {
    const kind = r.status === 403 ? "blocked" : r.error === "timeout" ? "timeout" : "http";
    return { ok: false, kind, status: r.status, message: `wix page fetch failed (${r.status || r.error})`, checkedAt };
  }
  return parseWix(r.body, item);
}
