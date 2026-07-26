// NET-A-PORTER.
//
// The easy kind: the product page ships a schema.org ProductGroup whose
// hasVariant[] entries each carry their own offer, so parseJsonLd reads it
// unchanged — same treatment as Farfetch and MR PORTER.
//
// COST, measured 2026-07-26 against the live page: plain and render both TIME
// OUT; only `super` (10 credits) comes back. That makes this one of the two most
// expensive stores we track, so it sits on the daily cadence — the bot quotes
// the monthly figure before anyone commits to it.
//
// CURRENCY: an /en-sg/ URL still prices in USD — the page reads
// "US$1,472 / Approx. SGD 1,900", and the JSON-LD's priceCurrency:USD is
// correct. Don't be tempted to infer SGD from the locale: the approximate
// conversion is display sugar, and the charge is in USD.

import { fetchMaybeUnblocked } from "../unblocker.mjs";
import { parseJsonLd, hasJsonLdProduct } from "./jsonld.mjs";

/** @param {import("../types.mjs").Item} item */
export async function readNetaporter(item, ctx = {}) {
  const checkedAt = new Date().toISOString();
  const res = await fetchMaybeUnblocked(item, {
    apiKey: ctx.unblockerKey,
    provider: ctx.unblockerProvider,
    startTier: ctx.startTier,
    country: "sg",
    // A challenge page carries no product JSON-LD — the signal to escalate
    // rather than parse a shell. Shared gate: see hasJsonLdProduct.
    validate: hasJsonLdProduct,
  });
  if (!res.ok) {
    const kind = res.status === 403 ? "blocked" : res.error === "timeout" ? "timeout" : "http";
    return { ok: false, kind, status: res.status, message: `netaporter: ${res.message}`, checkedAt };
  }

  const out = parseJsonLd(res.html, item);
  if (out.ok) { out.tier = res.tier; out.cost = res.cost; out.remaining = res.remaining; }
  return out;
}
