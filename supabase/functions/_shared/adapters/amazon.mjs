// Amazon adapter.
//
// Measured 2026-07-21: amazon.sg returns a full product page through Scrape.do
// on a PLAIN 1-credit request — the cheapest defended brand we have, cheaper
// than the 5-credit dedicated Amazon endpoints vendors sell. Direct fetches from
// a datacentre IP get a 2.8KB "Server Busy" shell, so a key is required (a
// self-hoster on a home connection may get it free — hence direct-first).
//
// PER-SIZE, FOR FREE: on Amazon each size is its own ASIN, so the link someone
// pastes already identifies their size. Tracking that ASIN *is* per-size
// tracking — no variant matrix to parse, no size picker to resolve.
//
// Amazon ships no JSON-LD, so our price cross-check reports "unknown" here. That
// is a real gap in coverage rather than a silent one.

import { fetchMaybeUnblocked } from "../unblocker.mjs";
import { STATE, isBuyable } from "../stock.mjs";
import { decodeEntities } from "../text.mjs";

/** Marketplace -> currency. Amazon doesn't label the currency in the markup. */
const MARKET_CURRENCY = {
  sg: "SGD", com: "USD", "co.uk": "GBP", de: "EUR", fr: "EUR", it: "EUR", es: "EUR",
  nl: "EUR", "co.jp": "JPY", "com.au": "AUD", ca: "CAD", in: "INR", "com.mx": "MXN",
  "com.br": "BRL", ae: "AED", sa: "SAR", se: "SEK", pl: "PLN", "com.tr": "TRY",
};

export function marketplaceOf(url) {
  const m = String(url).match(/amazon\.((?:com?\.)?[a-z.]{2,6}?)(?:\/|$)/i);
  return m ? m[1].toLowerCase() : null;
}

export function asinOf(url) {
  const m = String(url).match(/\/(?:dp|gp\/product|gp\/aw\/d|product)\/([A-Z0-9]{10})/i);
  return m ? m[1].toUpperCase() : null;
}

/**
 * Amazon states availability in prose, so we read prose — and the phrasing is
 * per-language. Returns NULL when we can't classify it, which the caller turns
 * into a soft failure. Guessing "sold out" for wording we don't recognise would
 * fire a false SOLD OUT on a perfectly available item and then go silent
 * forever, which is worse than admitting we can't read the page.
 */
export function stateFromAvailability(text) {
  const t = String(text ?? "").toLowerCase().trim();
  if (!t) return null;
  if (/currently unavailable|out of stock|we don't know when|unavailable\b/.test(t)) return STATE.OUT_OF_STOCK;
  if (/only \d+ left|order soon/.test(t)) return STATE.LOW_STOCK;
  if (/in stock|in stock soon|usually (ships|dispatch)|available to ship|dispatched within/.test(t)) return STATE.IN_STOCK;
  return null;
}

const clean = (s) => decodeEntities(String(s ?? "")).replace(/\s+/g, " ").trim();

/**
 * Does this page carry the stock markup we actually read? Used as the fetch
 * gate: a page without it is a thin render to escalate past, not a reading.
 * Kept in step with the selectors parseAmazon uses below.
 */
export function hasAvailabilityBlock(html) {
  return /primary-availability-message|id="availability"/i.test(String(html));
}

/**
 * @param {string} html
 * @param {import("../types.mjs").Item} item
 * @returns {import("../types.mjs").ReadResult}
 */
export function parseAmazon(html, item) {
  const checkedAt = new Date().toISOString();
  const asin = item.variantSelector?.asin ?? asinOf(item.url);

  const title = clean((html.match(/id="productTitle"[^>]*>([^<]+)/i) || [])[1]);
  if (!title) {
    return { ok: false, kind: "parse", message: "amazon: no productTitle (blocked shell, or the page shape changed)", checkedAt };
  }

  // Price is split across two spans: <a-price-whole>16<a-price-fraction>95
  const whole = (html.match(/class="a-price-whole"[^>]*>([\d.,]+)/i) || [])[1];
  const frac = (html.match(/class="a-price-fraction"[^>]*>(\d+)/i) || [])[1];
  let price;
  if (whole) {
    const w = whole.replace(/[.,]\s*$/, "").replace(/,/g, "");
    price = Number(frac ? `${w}.${frac}` : w);
  }
  if (!Number.isFinite(price)) price = undefined;

  // The availability block opens with a <style> element, so "first span wins"
  // picks up CSS. Take a generous window, drop style/script, then read the text.
  // Amazon puts the stock line in a dedicated class, ~67k characters away from
  // id="availability". An earlier version scanned a window after that id and
  // appeared to work on the full page purely by coincidence — this targets the
  // element that actually holds the text.
  const availabilityText = clean(
    (html.match(/primary-availability-message[^>]*>([^<]{2,90})</i) || [])[1] ??
    (html.match(/id="availability"[\s\S]{0,120000}?a-color-(?:success|error|price)[^>]*>([^<]{2,90})</i) || [])[1] ??
    "",
  );
  const state = stateFromAvailability(availabilityText);
  if (state === null) {
    return {
      ok: false,
      kind: "soft", // parsed the page, couldn't trust the answer
      message: availabilityText
        ? `amazon: unrecognised availability wording ("${availabilityText.slice(0, 40)}") — likely a non-English marketplace`
        : "amazon: no availability text found (page shape changed?)",
      checkedAt,
    };
  }

  // A missing price on an otherwise-parsed page means "can't be bought right
  // now" far more often than "free", so don't report availability off it — an
  // Amazon item that's genuinely unavailable shows no price at all (see the
  // amazon-sg-unavailable fixture), and its state says OUT_OF_STOCK.
  //
  // But if the stock line says BUYABLE and the price is still missing, those two
  // disagree, and the likeliest explanation is a half-rendered page. Refuse
  // rather than call a live item unavailable.
  if (isBuyable(state) && price == null) {
    return { ok: false, kind: "soft", message: "amazon: stock reads as available but the price is missing (partial page)", checkedAt };
  }
  const available = isBuyable(state) && price != null;

  const currency = item.currency ?? MARKET_CURRENCY[marketplaceOf(item.url) ?? ""] ?? "";

  // One ASIN is one size/colour on Amazon, so the reading has exactly one variant.
  return {
    ok: true,
    price,
    currency,
    available,
    variants: [{
      id: String(asin ?? "default"),
      label: item.variantLabel ?? title.slice(0, 60),
      price,
      available,
      state,
    }],
    checkedAt,
  };
}

/** @param {import("../types.mjs").Item} item */
export async function readAmazon(item, ctx = {}) {
  const checkedAt = new Date().toISOString();
  const asin = item.variantSelector?.asin ?? asinOf(item.url);
  if (!asin) {
    return { ok: false, kind: "parse", message: "amazon: no ASIN in that link (expected /dp/XXXXXXXXXX)", checkedAt };
  }

  const res = await fetchMaybeUnblocked(item, {
    apiKey: ctx.unblockerKey,
    provider: ctx.unblockerProvider,
    startTier: ctx.startTier,
    country: marketplaceOf(item.url) === "sg" ? "sg" : undefined,
    // What we need is a title AND an availability block — validating only the
    // title was too weak. Amazon serves datacentre IPs a degraded page that DOES
    // carry a productTitle but omits the availability section, so it sailed
    // through this gate, got accepted as a direct fetch, and then failed the
    // parse ("no availability text found") — 4 of 5 scheduled checks on a book
    // that reads perfectly from a residential IP. Demand the stock markup here
    // and a thin page escalates up the unblocker ladder instead of soft-failing.
    //
    // Deliberately NOT requiring a price marker: a genuinely "Currently
    // unavailable" item shows no price, and demanding one would burn every tier
    // and then fail on a page we could actually read.
    validate: (html) => html.includes('id="productTitle"') && hasAvailabilityBlock(html),
  });
  if (!res.ok) {
    const kind = res.status === 403 ? "blocked" : res.error === "timeout" ? "timeout" : "http";
    return { ok: false, kind, status: res.status, message: `amazon: ${res.message}`, checkedAt };
  }

  const out = parseAmazon(res.html, item);
  if (out.ok) { out.tier = res.tier; out.cost = res.cost; out.remaining = res.remaining; }
  return out;
}
