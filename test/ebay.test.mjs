import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseEbay, parseMoney, itemIdOf, stateFromEbay } from "../supabase/functions/_shared/adapters/ebay.mjs";
import { normalizeUrl } from "../supabase/functions/_shared/urlguard.mjs";
import { STATE } from "../supabase/functions/_shared/stock.mjs";

const fixture = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8");

// Both captured live 2026-07-21. They differ by LISTING TYPE, which is the axis
// that actually changes eBay's behaviour — not by product.
const AUCTION = fixture("ebay-auction.html");   // Carhartt jacket, "Place bid"
const FIXED = fixture("ebay-fixed.html");       // ?var= listing, "10 available"

test("parses a real fixed-price listing: title, USD price, stock", () => {
  const r = parseEbay(FIXED, { url: "https://www.ebay.com/itm/287062522407?var=589110017587" });
  assert.equal(r.ok, true);
  assert.equal(r.price, 5.99, "the variation price, not the $5.69 headline");
  assert.equal(r.currency, "USD");
  assert.equal(r.available, true);
  assert.equal(r.variants[0].state, STATE.IN_STOCK, "10 available, despite neighbours' sold-out badges");
  // eBay writes " as &#034; — a raw title would read 10/12/14&#034; Electronic.
  assert.match(r.title, /^10\/12\/14" Electronic Throttle/);
});

// The listing Wilson first sent turned out to be an auction. Its "US $143.50" is
// a CURRENT BID: it only rises, so a price-drop alert could never fire.
test("a real auction page is refused permanently, on sight", () => {
  const r = parseEbay(AUCTION, { url: "https://www.ebay.com/itm/307063458775" });
  assert.equal(r.ok, false);
  assert.equal(r.kind, "permanent");
  assert.match(r.message, /only ever goes up/);
});

// Captured live 2026-07-23: eBay served a BROKEN buy-box ("Oops! …trouble
// connecting to our server. Refresh Browser") in place of the CTA, so the kind
// couldn't be read from it and the whole listing soft-failed ("couldn't tell
// whether this listing is live"). The price block still renders "or Best Offer",
// which is enough to know it's a live fixed-price listing.
test("a broken buy-box falls back to the price block, not a soft failure", () => {
  const r = parseEbay(fixture("ebay-buybox-error.html"), { url: "https://www.ebay.com/itm/318509998125" });
  assert.equal(r.ok, true, "must not soft-fail just because eBay's buy-box module errored");
  assert.equal(r.price, 275);
  assert.equal(r.variants[0].state, STATE.IN_STOCK);
  assert.match(r.title, /Carhartt Brown Detroit/);
});

test("eBay's money formats parse, including the European decimal", () => {
  assert.deepEqual(parseMoney("US $143.50"), { price: 143.5, currency: "USD" });
  assert.deepEqual(parseMoney("AU $1,299.00"), { price: 1299, currency: "AUD" });
  assert.deepEqual(parseMoney("£85.00"), { price: 85, currency: "GBP" });
  assert.deepEqual(parseMoney("S$12.34"), { price: 12.34, currency: "SGD" });
  assert.deepEqual(parseMoney("€1.234,56"), { price: 1234.56, currency: "EUR" });
});

// Listings END here — a one-off that sells is gone, not restocked. Reporting it
// as available would send someone to a dead page.
test("an ended listing is out of stock, not in stock", () => {
  assert.equal(stateFromEbay("<p>This listing has ended.</p><a>Buy It Now</a>"), STATE.OUT_OF_STOCK);
  assert.equal(stateFromEbay("<p>This item is no longer available</p>"), STATE.OUT_OF_STOCK);
});

const qty = (text) => `<div id="qtyAvailability">${text}</div>`;

test("quantity wording maps to states, read from the listing's OWN container", () => {
  assert.equal(stateFromEbay(qty("Last one")), STATE.LOW_STOCK);
  assert.equal(stateFromEbay(qty("2 available")), STATE.LOW_STOCK);
  assert.equal(stateFromEbay(qty("10 available 6 sold")), STATE.IN_STOCK);
  assert.equal(stateFromEbay(qty("Out of stock")), STATE.OUT_OF_STOCK);
  assert.equal(stateFromEbay(qty("0 available")), STATE.OUT_OF_STOCK);
});

// THE BUG THIS CAUGHT: an eBay page carries carousels of OTHER listings, each
// with its own badge. This page had four "LAST ONE" and three "Out of stock"
// markers belonging to neighbours while the item itself had ten available.
test("a neighbour's badge never decides OUR item's stock", () => {
  const page = `<div class="carousel">LAST ONE</div><div>Out of stock</div>`
    + qty("10 available 6 sold")
    + `<div class="more-carousel">LAST ONE</div>`;
  assert.equal(stateFromEbay(page), STATE.IN_STOCK);
});

test("auctions are refused permanently, not tracked", () => {
  const auction = `<title>Vintage jacket | eBay</title><div class="x-buybox"><div class="x-buybox-cta">Place bid Add to Watchlist</div></div>`;
  const r = parseEbay(auction, { url: "https://www.ebay.com/itm/307063458775" });
  assert.equal(r.ok, false);
  assert.equal(r.kind, "permanent", "an auction will never become a fixed-price listing");
  assert.match(r.message, /only ever goes up/);
});

test("a fixed-price listing with no quantity line is still in stock", () => {
  const page = `<title>Thing | eBay</title><div class="x-buybox"><div class="x-buybox-cta">Buy It Now Add to cart</div></div>`;
  assert.equal(stateFromEbay(page), STATE.IN_STOCK);
});

test("the eBay variation id survives, because it changes the price", () => {
  // Measured on one listing: US $5.69 without ?var=, US $5.99 with it.
  const withVar = normalizeUrl("https://www.ebay.com.sg/itm/287062522407?_skw=x&hash=y&var=589110017587");
  assert.equal(withVar, "https://www.ebay.com/itm/287062522407?var=589110017587");
  assert.notEqual(withVar, normalizeUrl("https://www.ebay.com/itm/287062522407"));
});

test("a page we can't classify is a SOFT failure, never a false 'in stock'", () => {
  const r = parseEbay("<html><title>Something | eBay</title><body>nothing useful</body></html>", { url: "https://www.ebay.com/itm/123456789" });
  assert.equal(r.ok, false);
  assert.equal(r.kind, "soft");
});

test("item ids survive eBay's tracking wall, and regional hosts fold to .com", () => {
  const messy = "https://www.ebay.com.sg/itm/307063458775?_skw=carhartt+j97&itmmeta=01KY225&hash=item477e688bd7%3Ag%3AH1g&keyword=carhartt&sacat=0";
  assert.equal(itemIdOf(messy), "307063458775");
  // Regional hosts cannot be reached through the unblocker; ids are global.
  assert.equal(normalizeUrl(messy), "https://www.ebay.com/itm/307063458775");
  assert.equal(normalizeUrl("https://www.ebay.co.uk/itm/x/307063458775?x=1"), "https://www.ebay.com/itm/307063458775");
});

test("two people sharing one listing create ONE product row", () => {
  const a = "https://www.ebay.com.sg/itm/307063458775?_skw=carhartt&hash=abc";
  const b = "https://www.ebay.com/itm/307063458775?campid=999&toolid=1";
  assert.equal(normalizeUrl(a), normalizeUrl(b));
});
