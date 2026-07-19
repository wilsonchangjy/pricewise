// Bershka adapter. Like Stradivarius, Bershka exposes the Inditex itxrest API
// directly and FREE (HTTP 200, no unblocker) with per-size visibilityValue — but
// via the v3 `productsArray` batch endpoint rather than v2 `product/{id}/detail`.
// We fetch a single product and reuse the tested parseInditex via a wrap.
//
//   /itxrest/3/catalog/store/{storeId}/{catalogId}/productsArray?productIds={id}&...
//
// productId is the page URL's c0p{ID}. Track a size via variantSelector
// { storeId, catalogId, productId, size }.

import { httpGet } from "../fetcher.mjs";
import { parseInditex } from "./inditex.mjs";

const apiUrl = (sel) =>
  `https://www.bershka.com/itxrest/3/catalog/store/${sel.storeId}/${sel.catalogId}` +
  `/productsArray?productIds=${sel.productId}&appId=2&languageId=-1&locale=en_US`;

/** @param {import("../types.mjs").Item} item */
export async function readBershka(item) {
  const checkedAt = new Date().toISOString();
  const sel = item.variantSelector ?? {};
  if (!sel.storeId || !sel.catalogId || !sel.productId) {
    return { ok: false, kind: "parse", message: "bershka: variantSelector needs storeId/catalogId/productId", checkedAt };
  }
  const r = await httpGet(apiUrl(sel), { headers: { accept: "application/json" } });
  if (!r.ok) {
    const kind = r.status === 403 ? "blocked" : r.error === "timeout" ? "timeout" : "http";
    return { ok: false, kind, status: r.status, message: `bershka itxrest failed (${r.status || r.error})`, checkedAt };
  }
  if (!r.body.includes("visibilityValue")) {
    return { ok: false, kind: "parse", message: "bershka: no visibilityValue in itxrest response (shape changed?)", checkedAt };
  }
  // Single product requested -> the first sizes array found is this product's.
  return parseInditex(`<script type="application/json">${r.body}</script>`, item);
}
