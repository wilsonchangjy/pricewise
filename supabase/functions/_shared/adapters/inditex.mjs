// Inditex adapter (Massimo Dutti, Zara, etc.) — the DEFENDED pain-item reader.
//
// Why this exists: Inditex pages return HTTP 403 to plain fetches and DON'T ship
// a JSON-LD `Product` (only a `ProductGroup` with product-level availability,
// which lies — it says InStock even when your size is sold out). The real
// per-size stock lives in an embedded state script:
//
//   <script id="mdfrontw-state" type="application/json">
//     { "ITX_GET_PRODUCT_DETAIL_KEY": {
//         "priceInfo": { "price": 7900, "oldPrice": 15900, ... },   // cents
//         "status": { "selectedColor": { "sizes": [
//           { "sku": 57437322, "name": "S", "visibilityValue": "SOLD_OUT",
//             "isBuyable": true, "price": "7900", "oldPrice": "15900" }, ...
//         ]}}}}
//   </script>
//
// STOCK TRUTH = `visibilityValue === "SHOW"`. We validated this 4/4 against the
// live page (spike 2026-06-28): S/M = SOLD_OUT, L/XL = SHOW, matching the site's
// "SEE SIMILAR" markers. `isBuyable` is NOT stock — it's true even for sold-out
// sizes (it means "is a sellable SKU"), so we deliberately ignore it.
//
// Track a specific size via item.variantId = that size's SKU (e.g. "57437322").
//
// parseInditex() is pure (takes HTML) so it is unit-tested against a real,
// trimmed fixture (test/fixtures/massimodutti-state.html).

import { fetchMaybeUnblocked } from "../unblocker.mjs";

const IN_STOCK = "SHOW"; // the only value that means "buy it now"
const OUT_OF_STOCK = "SOLD_OUT"; // known sold-out marker
const cents = (n) => (n == null || n === "" ? undefined : Number(n) / 100);

/**
 * @param {string} html
 * @param {import("../types.mjs").Item} item
 * @returns {import("../types.mjs").ReadResult}
 */
export function parseInditex(html, item) {
  const checkedAt = new Date().toISOString();

  // The product state is a JSON <script>. Grab the application/json block that
  // carries the size stock field; parse it (no brittle string scraping).
  const blocks = [
    ...String(html).matchAll(
      /<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi,
    ),
  ].map((m) => m[1]);
  const raw = blocks.find((b) => b.includes("visibilityValue"));
  if (!raw) {
    return { ok: false, kind: "parse", message: "inditex: no state script with visibilityValue (page shape changed or not rendered)", checkedAt };
  }

  let state;
  try {
    state = JSON.parse(raw);
  } catch {
    return { ok: false, kind: "parse", message: "inditex: state script was not valid JSON", checkedAt };
  }

  // Find the size array by SHAPE (objects carrying visibilityValue), not a
  // hardcoded path — this covers different Inditex layouts: Massimo Dutti
  // (ITX_GET_PRODUCT_DETAIL_KEY.status.selectedColor.sizes), Oysho
  // (PRODUCT_HYDRATION_KEY.product.colors[].sizes), etc.
  const sizes = findSizesArray(state);
  if (!Array.isArray(sizes) || sizes.length === 0) {
    return { ok: false, kind: "parse", message: "inditex: no sizes[] with visibilityValue found (shape changed?)", checkedAt };
  }

  // Vocabulary guard: if we recognise NONE of the stock markers, Inditex likely
  // renamed them — refuse rather than silently report everything out of stock
  // (a false "sold out" is bad; a false "in stock" is worse). Surfaced upstream.
  const vocab = new Set(sizes.map((s) => s.visibilityValue));
  if (!vocab.has(IN_STOCK) && !vocab.has(OUT_OF_STOCK)) {
    return {
      ok: false,
      kind: "parse",
      message: `inditex: unrecognised visibilityValue vocabulary [${[...vocab].join(", ")}] (stock field changed — DO NOT trust)`,
      checkedAt,
    };
  }

  const variants = sizes.map((s) => {
    const price = cents(s.priceInfo?.price) ?? cents(s.price);
    const oldPrice = cents(s.priceInfo?.oldPrice) ?? cents(s.oldPrice);
    return {
      id: String(s.sku),
      label: String(s.name ?? s.sku),
      price,
      compareAtPrice: oldPrice && price != null && oldPrice > price ? oldPrice : undefined,
      available: s.visibilityValue === IN_STOCK,
      sizeCode: s.name != null ? String(s.name) : undefined,
    };
  });

  // Track by size name (variantSelector.size) or by SKU (variantId).
  const sel = item.variantSelector ?? {};
  const chosen = sel.size != null
    ? variants.find((v) => v.sizeCode === String(sel.size))
    : item.variantId ? variants.find((v) => v.id === String(item.variantId)) : undefined;
  if (sel.size != null && !chosen) {
    return { ok: false, kind: "parse", message: `inditex: size ${sel.size} not in sizes`, checkedAt };
  }
  const headlinePrice = chosen?.price ?? variants.find((v) => v.price != null)?.price;
  const compareAtPrice = chosen?.compareAtPrice;
  const available = chosen ? chosen.available : variants.some((v) => v.available);

  return {
    ok: true,
    price: headlinePrice,
    currency: item.currency ?? "",
    compareAtPrice,
    available,
    variants,
    checkedAt,
  };
}

// Recursively find the size array: objects carrying BOTH `visibilityValue` and a
// `sku` (that pair uniquely marks a size). Requiring `sku` avoids matching
// higher-level product/colour objects that also carry `visibilityValue` but key
// off `id` (e.g. Bershka's itxrest response nests sizes under the product).
function findSizesArray(node) {
  if (Array.isArray(node)) {
    if (node.some((x) => x && typeof x === "object" && "visibilityValue" in x && "sku" in x)) return node;
    for (const x of node) { const r = findSizesArray(x); if (r) return r; }
  } else if (node && typeof node === "object") {
    for (const k of Object.keys(node)) { const r = findSizesArray(node[k]); if (r) return r; }
  }
  return null;
}

/**
 * Fetch + parse. Direct fetch first (free); on a block, route through the
 * tiered unblocker (render-only ~5cr, escalating only if blocked) when a key is
 * configured. Without a key we surface the block honestly.
 * @param {import("../types.mjs").Item} item
 */
export async function readInditex(item, ctx = {}) {
  const checkedAt = new Date().toISOString();
  const res = await fetchMaybeUnblocked(item, { apiKey: ctx.unblockerKey, country: "sg", validate: (html) => html.includes("visibilityValue") });
  if (!res.ok) {
    const kind = res.status === 403 ? "blocked" : res.error === "timeout" ? "timeout" : "http";
    return { ok: false, kind, status: res.status, message: `inditex: ${res.message}`, checkedAt };
  }
  return parseInditex(res.html, item);
}
