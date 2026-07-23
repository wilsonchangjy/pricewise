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
  // Ended listings are a page-level fact, so this check is page-wide.
  if (/This listing (has ended|was ended)|no longer available|item is no longer/i.test(html)) {
    return STATE.OUT_OF_STOCK;
  }

  // EVERYTHING ELSE MUST BE SCOPED. An eBay page carries carousels of other
  // people's listings, each with its own badge — this page had four "LAST ONE"
  // and three "Out of stock" markers belonging to neighbours, while the item
  // itself had ten available. Scanning the whole page reported a sold-out item
  // as buyable.
  const region = availabilityRegion(html);
  if (region === null) {
    // Plenty of fixed-price listings show no quantity line at all; a live buy
    // control is then the only honest signal we have.
    return listingKind(html) === "fixed" ? STATE.IN_STOCK : null;
  }

  if (/out of stock|sold out/i.test(region)) return STATE.OUT_OF_STOCK;
  if (/last one/i.test(region)) return STATE.LOW_STOCK;

  const n = Number((region.match(/(\d+)\s+available/i) || [])[1] ?? NaN);
  if (Number.isFinite(n)) return n === 0 ? STATE.OUT_OF_STOCK : n <= 2 ? STATE.LOW_STOCK : STATE.IN_STOCK;
  if (/more than \d+ available/i.test(region)) return STATE.IN_STOCK;

  return null;
}

/**
 * Fixed price or auction? The buy-box CTA is the tell: "Buy It Now"/"Add to
 * cart" versus "Place bid". It matters because an auction's price is the
 * CURRENT BID — it only ever rises — so a price-drop alert could never fire
 * and every bid would look like a price increase.
 */
export function listingKind(html) {
  const i = String(html).search(/x-buybox/i);
  if (i >= 0) {
    const cta = String(html).slice(i, i + 2500).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    if (/Buy It Now|Add to cart|Add to basket/i.test(cta)) return "fixed";
    if (/Place bid|Bid now/i.test(cta)) return "auction";
    // Buybox present but no CTA in it — eBay sometimes serves a broken module
    // ("Oops! …trouble connecting to our server. Refresh Browser") in the CTA's
    // place. Don't give up: fall through to the price area, which still renders.
  }
  // The primary-price block survives a broken buybox and reveals the kind — a
  // fixed listing shows "Buy It Now"/"or Best Offer" beside the price, an auction
  // shows a bid count. Scoped to ~400 chars so a carousel's CTA can't leak in.
  const p = String(html).search(/x-price-primary/i);
  if (p >= 0) {
    const near = String(html).slice(p, p + 400).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    if (/or Best Offer|Buy It Now/i.test(near)) return "fixed";
    if (/\bbids?\b|Current bid/i.test(near)) return "auction";
  }
  return null;
}

/** The listing's OWN availability line, as plain text. */
function availabilityRegion(html) {
  const m = String(html).match(/(?:id="?qtyAvailability|x-quantity__availability)[^>]*>([\s\S]{0,300})/i);
  if (!m) return null;
  // Cut at the container's own closing tag. Without this the window runs on
  // into the next carousel and picks up a neighbour's "LAST ONE".
  const own = m[1].split(/<\/(?:div|span|ul)>/i)[0];
  return own.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
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

  // Auctions are a different product from the one we alert on. Say so once,
  // permanently, instead of tracking a number that can only go up.
  if (listingKind(html) === "auction") {
    return {
      ok: false,
      kind: "permanent",
      message: "that's an eBay auction, and I only track fixed-price listings — an auction's price is the current bid, so it only ever goes up and a price-drop alert could never fire. A 'Buy It Now' listing works fine.",
      checkedAt,
    };
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
      id: String(item.variantSelector?.variation ?? item.variantSelector?.itemId ?? itemIdOf(item.url) ?? "default"),
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
