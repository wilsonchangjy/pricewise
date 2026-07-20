// Zara adapter (Inditex, but a DIFFERENT frontend from Massimo Dutti — no
// mdfrontw-state / visibilityValue). Verified live 2026-07-03: Zara exposes
// per-size stock cleanly in JSON-LD @type=ProductGroup, each hasVariant a
// Product with its own offer + availability. So we just reuse parseJsonLd.
//
// Defended: direct fetch 403s, so we go through the tiered unblocker (worked on
// the cheapest 5-credit render tier). Track a size via item.variantId = that
// size's Zara sku (e.g. "519188937-251-2" for size S).

import { fetchMaybeUnblocked } from "../unblocker.mjs";
import { parseJsonLd } from "./jsonld.mjs";

/** @param {import("../types.mjs").Item} item */
export async function readZara(item, ctx = {}) {
  const checkedAt = new Date().toISOString();
  const res = await fetchMaybeUnblocked(item, { apiKey: ctx.unblockerKey, provider: ctx.unblockerProvider, country: "sg", validate: (html) => html.includes("application/ld+json") });
  if (!res.ok) {
    const kind = res.status === 403 ? "blocked" : res.error === "timeout" ? "timeout" : "http";
    return { ok: false, kind, status: res.status, message: `zara: ${res.message}`, checkedAt };
  }
  return parseJsonLd(res.html, item);
}
