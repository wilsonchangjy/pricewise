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
//
//    And eBay says so in its OWN words, which are not the ones we first guessed:
//    a sold one-off reads "This listing sold on Tue, Jul 21 at 2:52 PM." Only
//    "has ended" / "was ended" were recognised, so a sold Carhartt jacket read as
//    IN STOCK at US $275 for 54 days and nobody was told. See endedListing().

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
 * The phrases eBay uses when a listing is OVER. Kept non-global so .test() has
 * no lastIndex state; endedListing() makes its own global copy to walk matches.
 */
const ENDED = /This listing (?:sold|ended|has ended|was ended)\b[^<]{0,80}|Bidding (?:has )?ended[^<]{0,60}|(?:This item is )?no longer available|item is no longer[^<]{0,40}/i;

/** Is this offset inside a <style> or <script> block rather than rendered markup? */
const inStyleOrScript = (s, i) =>
  s.lastIndexOf("<style", i) > s.lastIndexOf("</style", i) ||
  s.lastIndexOf("<script", i) > s.lastIndexOf("</script", i);

/**
 * Has this listing ENDED — sold, or ended by the seller?
 *
 * Returns null for a live listing, otherwise what eBay said:
 *   { sold, when, message, relistUrl }
 *
 * FOUND THE HARD WAY. The sold page for 318509998125 has no quantity line and an
 * empty buy-box, so the parser fell through to the price block — which still
 * shows "US $275.00 or Best Offer", struck through — and called it a live
 * fixed-price listing. A July fix made that worse: the soft failures were eBay's
 * sold page all along, misread as a "broken buy-box" because every eBay page
 * carries a hidden "Oops! …trouble connecting" template. The fixture that fix
 * added (now ebay-sold-no-banner.html) was this page with its banner trimmed off.
 *
 * The relist link is taken only when it sits right against "relisted this item"
 * in the banner. The sold page carries ~50 other /itm/ links in its carousels,
 * and following one of those would offer someone a stranger's jacket.
 */
export function endedListing(html) {
  const s = String(html);
  const walk = new RegExp(ENDED.source, "gi");
  let m;
  while ((m = walk.exec(s))) {
    if (inStyleOrScript(s, m.index)) continue;
    const message = decodeEntities(m[0]).replace(/\s+/g, " ").trim();
    const window = s.slice(m.index, m.index + 1500);
    const relistUrl = (window.match(
      /href=["']?(https:\/\/www\.ebay\.com\/itm\/\d{9,})[^>]*>(?:\s|<[^>]+>)*relisted this item/i,
    ) || [])[1] ?? null;
    return {
      sold: /\bsold\b/i.test(message),
      when: (message.match(/\bon ((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), [A-Z][a-z]{2} \d{1,2})\b/) || [])[1] ?? null,
      message: message.slice(0, 160),
      relistUrl,
    };
  }
  return null;
}

/**
 * eBay states availability in prose and it varies by listing type. Unrecognised
 * wording means we don't know — never "in stock", which would send someone to a
 * listing that may have ended.
 */
export function stateFromEbay(html) {
  // Ended listings are a page-level fact, so this check is page-wide.
  if (endedListing(html)) return STATE.OUT_OF_STOCK;

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
    // A PRIMARY price that is struck through is a price no longer on offer — it
    // is how the sold page renders its old asking price. Without an ended banner
    // to go on, that is "can't tell", never "live".
    //
    // Judged on the FIRST text span inside the price block, which is the price
    // itself. eBay nests it two ways: today's page wraps it in
    // x-price-primary__price, the July capture through the unblocker did not.
    // A discounted live listing strikes its WAS price in a later element, so the
    // first span stays unstruck there.
    const firstSpan = String(html).slice(p, p + 400).match(/<span[^>]*\bux-textspans\b[^>]*>/i);
    if (firstSpan && /ux-textspans--STRIKETHROUGH/i.test(firstSpan[0])) return null;
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

  // An ENDED listing is reported as over, and it comes first: a finished auction
  // still shows its bids, and "I don't track auctions" is the wrong thing to tell
  // someone whose item just sold. No price is claimed — the struck "US $275.00"
  // is the old asking price, and "Best offer accepted" says it sold for something
  // else we can't see.
  const ended = endedListing(html);
  if (ended) {
    return {
      ok: true,
      price: undefined,
      currency: item.currency ?? "USD",
      available: false,
      ended,
      variants: [{
        id: String(item.variantSelector?.variation ?? item.variantSelector?.itemId ?? itemIdOf(item.url) ?? "default"),
        label: title.slice(0, 60),
        price: undefined,
        available: false,
        state: STATE.OUT_OF_STOCK,
      }],
      title,
      checkedAt,
    };
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

  // Stock says buyable but there's no price: that's a page we half-read, not an
  // item you can't buy. Saying "available: false" here fired a false SOLD OUT on
  // a live listing. Refuse instead — silence beats a wrong alert.
  if (isBuyable(state) && price == null) {
    return { ok: false, kind: "soft", message: "ebay: stock reads as live but the price is missing (partial page)", checkedAt };
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
    // Require the PRICE block, not "price OR title". The old OR let a page with
    // only a title through: price came back undefined, `available` collapsed to
    // false, and a live item fired a false "⛔ SOLD OUT". The price block is also
    // what listingKind falls back to, so it's the one element we cannot proceed
    // without. Ended listings are exempt — they legitimately may not price, and
    // stateFromEbay detects them page-wide.
    validate: (html) => /x-price-primary/.test(html) || ENDED.test(html),
  });
  if (!res.ok) {
    const kind = res.status === 403 ? "blocked" : res.error === "timeout" ? "timeout" : "http";
    return { ok: false, kind, status: res.status, message: `ebay: ${res.message}`, checkedAt };
  }

  const out = parseEbay(res.html, item);
  if (out.ok) { out.tier = res.tier; out.cost = res.cost; out.remaining = res.remaining; }
  return out;
}
