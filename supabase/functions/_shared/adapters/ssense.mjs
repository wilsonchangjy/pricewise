// SSENSE.
//
// A thin JSON-LD reader, like Farfetch and NET-A-PORTER — but PRODUCT-LEVEL
// ONLY. SSENSE publishes a schema.org Product with a single offer and no
// hasVariant, so there is no per-size stock to read here: we can tell you the
// price moved or the product sold out, not that your M came back. The bot says
// so at /add rather than implying the usual per-size wedge.
//
// Defended: a direct fetch 403s (measured 2026-07-27), so it needs the user's key.

import { fetchMaybeUnblocked } from "../unblocker.mjs";
import { parseJsonLd, hasJsonLdProduct } from "./jsonld.mjs";

/** @param {import("../types.mjs").Item} item */
export async function readSsense(item, ctx = {}) {
  const checkedAt = new Date().toISOString();
  const res = await fetchMaybeUnblocked(item, {
    apiKey: ctx.unblockerKey,
    provider: ctx.unblockerProvider,
    startTier: ctx.startTier,
    country: "sg",
    validate: hasJsonLdProduct,
  });
  if (!res.ok) {
    const kind = res.status === 403 ? "blocked" : res.error === "timeout" ? "timeout" : "http";
    return { ok: false, kind, status: res.status, message: `ssense: ${res.message}`, checkedAt };
  }
  const out = parseJsonLd(res.html, item);
  if (out.ok) { out.tier = res.tier; out.cost = res.cost; out.remaining = res.remaining; }
  return out;
}
