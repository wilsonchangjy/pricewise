import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseEbay, parseMoney, itemIdOf, stateFromEbay } from "../supabase/functions/_shared/adapters/ebay.mjs";
import { normalizeUrl } from "../supabase/functions/_shared/urlguard.mjs";
import { STATE } from "../supabase/functions/_shared/stock.mjs";

const FIXTURE = readFileSync(new URL("./fixtures/ebay-listing.html", import.meta.url), "utf8");

// Captured live 2026-07-21 from Wilson's watched listing.
test("parses a real listing: title, USD price, last-one stock", () => {
  const r = parseEbay(FIXTURE, { url: "https://www.ebay.com/itm/307063458775" });
  assert.equal(r.ok, true);
  assert.equal(r.price, 143.5);
  assert.equal(r.currency, "USD");
  assert.equal(r.variants[0].state, STATE.LOW_STOCK, "'LAST ONE' is exactly the signal that matters here");
  assert.match(r.title, /Carhartt J97/);
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

test("quantity wording maps to states", () => {
  assert.equal(stateFromEbay("<span>LAST ONE</span>"), STATE.LOW_STOCK);
  assert.equal(stateFromEbay("<span>2 available</span>"), STATE.LOW_STOCK);
  assert.equal(stateFromEbay("<span>More than 10 available</span>"), STATE.IN_STOCK);
  assert.equal(stateFromEbay("<span>Out of Stock</span>"), STATE.OUT_OF_STOCK);
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
