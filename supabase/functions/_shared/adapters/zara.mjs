// Zara adapter (Inditex, but a DIFFERENT frontend from Massimo Dutti — no
// mdfrontw-state / visibilityValue). Verified live 2026-07-03: Zara exposes
// per-size stock cleanly in JSON-LD @type=ProductGroup, each hasVariant a
// Product with its own offer + availability. So we just reuse parseJsonLd.
//
// Defended: direct fetch 403s, so we go through the tiered unblocker (worked on
// the cheapest 5-credit render tier). Track a size via item.variantId = that
// size's Zara sku (e.g. "519188937-251-2" for size S).

import { fetchMaybeUnblocked } from "../unblocker.mjs";
import { localeFromUrl } from "../locale.mjs";
import { parseJsonLd, hasJsonLdProduct } from "./jsonld.mjs";

/** @param {import("../types.mjs").Item} item */
export async function readZara(item, ctx = {}) {
  const checkedAt = new Date().toISOString();
  const res = await fetchMaybeUnblocked(item, { apiKey: ctx.unblockerKey, provider: ctx.unblockerProvider,
    startTier: ctx.startTier, // The storefront must be the SAME one every check, or a "price drop" is
    // just a different country's page. Prefer the row's pinned market, then
    // the link's own locale, then SG — the same precedence as everywhere else.
    country: (item.market ?? localeFromUrl(item.url).country ?? "sg").toLowerCase(),
    // Require the PRODUCT node, not merely "some JSON-LD on the page". Zara
    // ships JSON-LD for breadcrumbs and organisation markup too, so the old
    // check passed on category pages and challenge shells alike — anything with
    // a single <script type="application/ld+json"> sailed through and then
    // failed the parse, without ever escalating a tier. Same gate as Farfetch
    // and MR PORTER, which read through the identical parser.
    validate: hasJsonLdProduct });
  if (!res.ok) {
    const kind = res.status === 403 ? "blocked" : res.error === "timeout" ? "timeout" : "http";
    return { ok: false, kind, status: res.status, message: `zara: ${res.message}`, checkedAt };
  }
  const out = parseJsonLd(res.html, item);
  if (out.ok) { out.tier = res.tier; out.cost = res.cost; out.remaining = res.remaining; }
  return out;
}
