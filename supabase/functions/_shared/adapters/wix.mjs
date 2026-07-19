// Wix Stores adapter. Wix has no clean product API (its Stores API needs the
// site's private tokens) and its JSON-LD often omits offers — but the product
// model IS server-rendered into the page under a state key:
//
//   ..."catalog":{"product":{ ..., isInStock, price, comparePrice, currency,
//                             inventory:{status}, isManageProductItems, productItems }}
//
// Wix sites are lightly defended (direct fetch = 200, FREE). This reads the
// PRODUCT-LEVEL price + availability, which fits single-product Wix items (many
// indie/studio stores). NOTE: products with MANAGED VARIANTS (isManageProductItems
// true) would need per-variant parsing of productItems[] — a future extension.

import { httpGet } from "../fetcher.mjs";

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

  const available = p.isInStock === true || p.inventory?.status === "in_stock";
  const price = p.discountedPrice != null ? Number(p.discountedPrice) : p.price != null ? Number(p.price) : undefined;
  const compareRaw = p.comparePrice != null ? Number(p.comparePrice) : undefined;
  const compareAtPrice = compareRaw && price != null && compareRaw > price ? compareRaw : undefined;
  const currency = p.currency ?? item.currency ?? "";

  return {
    ok: true,
    price,
    currency,
    compareAtPrice,
    available,
    variants: [{ id: "default", label: String(p.name ?? item.label), price, available }],
    checkedAt,
  };
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
