// Farfetch. Like Zara, its per-size stock is already in the page as a JSON-LD
// ProductGroup — each size a Product with its own offer and availability — so
// this is a thin fetch wrapper around the tested parseJsonLd.
//
// Measured 2026-07-21 through Scrape.do: a plain 1-credit request returns the
// full page, with SGD pricing on the /sg/ site. Cheapest tier we have.
//
// One wrinkle worth knowing: Farfetch puts price inside an ARRAY of
// UnitPriceSpecification rather than a plain `price` field. parseJsonLd handles
// both — before it did, this page read as per-size stock with NO price at all.

import { fetchMaybeUnblocked } from "../unblocker.mjs";
import { parseJsonLd } from "./jsonld.mjs";

/** @param {import("../types.mjs").Item} item */
export async function readFarfetch(item, ctx = {}) {
  const checkedAt = new Date().toISOString();
  const res = await fetchMaybeUnblocked(item, {
    apiKey: ctx.unblockerKey,
    provider: ctx.unblockerProvider,
    startTier: ctx.startTier,
    country: "sg",
    // A challenge page has no product JSON-LD — that's the signal to escalate
    // rather than parse a shell.
    validate: (html) => /"@type"\s*:\s*"(ProductGroup|Product)"/.test(html),
  });
  if (!res.ok) {
    const kind = res.status === 403 ? "blocked" : res.error === "timeout" ? "timeout" : "http";
    return { ok: false, kind, status: res.status, message: `farfetch: ${res.message}`, checkedAt };
  }

  const out = parseJsonLd(res.html, item);
  if (out.ok) { out.tier = res.tier; out.cost = res.cost; out.remaining = res.remaining; }
  return out;
}
