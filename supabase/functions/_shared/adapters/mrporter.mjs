// MR PORTER. Per-size stock arrives as a JSON-LD ProductGroup, so this is the
// same thin wrapper as Zara and Farfetch over the tested parseJsonLd.
//
// Measured 2026-07-21: the plain tier fails outright (502, proxy rotation) and
// only the residential/super tier gets through — 10 credits a check, tied with
// Zara as our most expensive store. Worth knowing before adding five of them.
//
// Prices are quoted in GBP even on /en-sg/, with an "approx SGD" shown on the
// page for convenience. GBP is what's actually charged, so GBP is what we track.
// Verified against a screenshot: £683 on screen, £683 parsed, and the size grid
// matched exactly (only M in stock of S/M/L/XL/XXL).

import { fetchMaybeUnblocked } from "../unblocker.mjs";
import { parseJsonLd } from "./jsonld.mjs";

/** @param {import("../types.mjs").Item} item */
export async function readMrPorter(item, ctx = {}) {
  const checkedAt = new Date().toISOString();
  const res = await fetchMaybeUnblocked(item, {
    apiKey: ctx.unblockerKey,
    provider: ctx.unblockerProvider,
    startTier: ctx.startTier,
    country: "sg",
    validate: (html) => /"@type"\s*:\s*"(ProductGroup|Product)"/.test(html),
  });
  if (!res.ok) {
    const kind = res.status === 403 ? "blocked" : res.error === "timeout" ? "timeout" : "http";
    return { ok: false, kind, status: res.status, message: `mrporter: ${res.message}`, checkedAt };
  }
  const out = parseJsonLd(res.html, item);
  if (out.ok) { out.tier = res.tier; out.cost = res.cost; out.remaining = res.remaining; }
  return out;
}
