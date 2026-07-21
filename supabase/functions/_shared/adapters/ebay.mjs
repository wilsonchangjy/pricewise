// eBay.
//
// The one store so far that ships NO product JSON-LD — only breadcrumbs — so
// this reads eBay's own markup. Measured 2026-07-21 via Scrape.do: a plain
// 1-credit request returns the full listing.
//
// TWO THINGS THAT MAKE EBAY DIFFERENT:
//
// 1. ebay.com.sg (and other regional hosts) cannot be reached through the
//    unblocker at all — ROTATION_FAILED, a connection failure rather than a
//    bot block. Item ids are global, so we canonicalise every eBay link to
//    www.ebay.com. The consequence is real and the bot says so at /add: prices
//    come back in USD, not the local currency shown on a regional site.
//
// 2. Listings END. A vintage one-off that sells is gone for good, not
//    restocked — which makes "still there?" the more valuable question here,
//    and an ended listing something we must report rather than retry forever.

import { fetchMaybeUnblocked } from "../unblocker.mjs";
import { STATE, isBuyable } from "../stock.mjs";
import { decodeEntities } from "../text.mjs";

/** eBay writes prices as "US $143.50", "AU $99.00", "£85.00", "S$12.34". */
const CURRENCY_TOKENS = [
  [/^US\s*\$/i, "USD"], [/^C\s*\$/i, "CAD"], [/^AU\s*\$/i, "AUD"],
  [/^S\$/i, "SGD"], [/^HK\s*\$/i, "HKD"], [/^NZ\s*\$/i, "NZD"],
  [/^£/, "GBP"], [/^€/, "EUR"], [/^¥/, "JPY"], [/^\$/, "USD"],
];

export function parseMoney(text) {
  const t = decodeEntities(String(text ?? "")).replace(/\s+/g, " ").trim();
  if (!t) return {};
  const currency = CURRENCY_TOKENS.find(([re]) => re.test(t))?.[1]
    ?? (t.match(/\b([A-Z]{3})\b/) || [])[1];
  const num = t.replace(/[^\d.,]/g, "");
  if (!num) return { currency };
  // Strip thousands separators, keep the decimal point.
  const normalised = num.includes(",") && /,\d{2}$/.test(num)
    ? num.replace(/\./g, "").replace(",", ".")   // 1.234,56 style
    : num.replace(/,/g, "");
  const price = Number(normalised);
  return { price: Number.isFinite(price) ? price : undefined, currency };
}

export function itemIdOf(url) {
  const m = String(url).match(/\/itm\/(?:[^/]*\/)?(\d{9,})/);
  return m ? m[1] : null;
}

/**
 * eBay states availability in prose and it varies by listing type. Unrecognised
 * wording means we don't know — never "in stock", which would send someone to a
 * listing that may have ended.
 */
export function stateFromEbay(html) {
  if (/This listing (has ended|was ended)|no longer available|item is no longer/i.test(html)) {
    return STATE.OUT_OF_STOCK;
  }
  if (/\bLAST ONE\b/i.test(html)) return STATE.LOW_STOCK;
  const avail = html.match(/(More than \d+ available|\d+ available|Out of [Ss]tock|Sold out)/);
  if (avail) {
    if (/out of stock|sold out/i.test(avail[1])) return STATE.OUT_OF_STOCK;
    // match() puts the whole match at [0]; reading [1] made every quantity 0,
    // so "2 available" reported as plenty in stock.
    const n = Number((avail[1].match(/\d+/) || [])[0] ?? 0);
    return n > 0 && n <= 2 ? STATE.LOW_STOCK : STATE.IN_STOCK;
  }
  // A live listing always renders a buy control; its absence is our signal.
  if (/Buy It Now|Add to cart|Place bid/i.test(html)) return STATE.IN_STOCK;
  return null;
}

/**
 * @param {string} html
 * @param {import("../types.mjs").Item} item
 * @returns {import("../types.mjs").ReadResult}
 */
export function parseEbay(html, item) {
  const checkedAt = new Date().toISOString();

  const rawTitle = (html.match(/x-item-title__mainTitle[^>]*>\s*<span[^>]*>([^<]{3,150})/i)
    || html.match(/<title[^>]*>([^<|]{3,150})/i) || [])[1];
  const title = decodeEntities(String(rawTitle ?? "")).replace(/\s+/g, " ").trim();
  if (!title) {
    return { ok: false, kind: "parse", message: "ebay: no listing title (blocked, or the page shape changed)", checkedAt };
  }

  const priceText = (html.match(/x-price-primary[\s\S]{0,300}?ux-textspans[^>]*>([^<]{2,40})/i) || [])[1];
  const { price, currency } = parseMoney(priceText);

  const state = stateFromEbay(html);
  if (state === null) {
    return { ok: false, kind: "soft", message: "ebay: couldn't tell whether this listing is live", checkedAt };
  }
  const available = isBuyable(state) && price != null;

  return {
    ok: true,
    price,
    currency: currency ?? item.currency ?? "USD",
    available,
    // One listing is one thing — eBay variations would need the msku data, and
    // most of what people watch here is a single one-off item.
    variants: [{
      id: String(item.variantSelector?.itemId ?? itemIdOf(item.url) ?? "default"),
      label: title.slice(0, 60),
      price,
      available,
      state,
    }],
    title,
    checkedAt,
  };
}

/** @param {import("../types.mjs").Item} item */
export async function readEbay(item, ctx = {}) {
  const checkedAt = new Date().toISOString();
  if (!itemIdOf(item.url)) {
    return { ok: false, kind: "parse", message: "ebay: no item id in that link (expected /itm/123456789)", checkedAt };
  }

  const res = await fetchMaybeUnblocked(item, {
    apiKey: ctx.unblockerKey,
    provider: ctx.unblockerProvider,
    startTier: ctx.startTier,
    validate: (html) => /x-price-primary|x-item-title__mainTitle/.test(html),
  });
  if (!res.ok) {
    const kind = res.status === 403 ? "blocked" : res.error === "timeout" ? "timeout" : "http";
    return { ok: false, kind, status: res.status, message: `ebay: ${res.message}`, checkedAt };
  }

  const out = parseEbay(res.html, item);
  if (out.ok) { out.tier = res.tier; out.cost = res.cost; out.remaining = res.remaining; }
  return out;
}
