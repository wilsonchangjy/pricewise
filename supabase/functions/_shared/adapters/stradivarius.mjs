// Stradivarius adapter. Unlike Zara/Massimo Dutti/Oysho (embedded page state),
// Stradivarius exposes the Inditex `itxrest` detail API directly — and it's FREE
// (HTTP 200, no unblocker). It returns the same per-size shape (objects with
// visibilityValue + name + price), so we reuse the tested parseInditex logic by
// wrapping the API JSON in a <script> the parser already understands.
//
//   /itxrest/2/catalog/store/{storeId}/{catalogId}/category/0/product/{productId}/detail
//
// Track a size via variantSelector { storeId, catalogId, productId, size }.

import { httpGet } from "../fetcher.mjs";
import { fetchApiViaUnblocker } from "../unblocker.mjs";
import { parseInditex } from "./inditex.mjs";

const apiUrl = (sel) =>
  `https://www.stradivarius.com/itxrest/2/catalog/store/${sel.storeId}/${sel.catalogId}` +
  `/category/0/product/${sel.productId}/detail?languageId=-1&appId=2`;

/** @param {import("../types.mjs").Item} item */
export async function readStradivarius(item, ctx = {}) {
  const checkedAt = new Date().toISOString();
  const sel = item.variantSelector ?? {};
  if (!sel.storeId || !sel.catalogId || !sel.productId) {
    return { ok: false, kind: "parse", message: "stradivarius: variantSelector needs storeId/catalogId/productId", checkedAt };
  }
  // Direct first — free, and it works from a residential IP (self-hosters).
  // Inditex 403s datacentre addresses, so fall back to the subscriber's key.
  let r = await httpGet(apiUrl(sel), { headers: { accept: "application/json" } });
  if (!r.ok && ctx.unblockerKey) {
    const un = await fetchApiViaUnblocker(apiUrl(sel), { apiKey: ctx.unblockerKey, provider: ctx.unblockerProvider });
    if (un.ok) r = { ok: true, status: un.status, body: un.body };
  }
  if (!r.ok) {
    const kind = r.status === 403 ? "blocked" : r.error === "timeout" ? "timeout" : "http";
    return { ok: false, kind, status: r.status, message: `stradivarius itxrest failed (${r.status || r.error})`, checkedAt };
  }
  if (!r.body.includes("visibilityValue")) {
    return { ok: false, kind: "parse", message: "stradivarius: no visibilityValue in itxrest response (shape changed?)", checkedAt };
  }
  // Reuse the Inditex per-size parser by presenting the API JSON as a state script.
  return parseInditex(`<script type="application/json">${r.body}</script>`, item);
}
