import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseAmazon, asinOf, marketplaceOf, stateFromAvailability } from "../supabase/functions/_shared/adapters/amazon.mjs";
import { STATE } from "../supabase/functions/_shared/stock.mjs";
import { normalizeUrl } from "../supabase/functions/_shared/urlguard.mjs";
import { decodeEntities } from "../supabase/functions/_shared/text.mjs";

const FIXTURE = readFileSync(new URL("./fixtures/amazon-sg-product.html", import.meta.url), "utf8");
const ITEM = { url: "https://www.amazon.sg/dp/B0BZJ512J2", label: "Champion tee" };

// Captured from the live page on 2026-07-21 (16.95 SGD, in stock) — the same
// numbers ScrapingBee's structured Amazon endpoint returned independently.
test("parses the real page: price, currency, availability", () => {
  const r = parseAmazon(FIXTURE, ITEM);
  assert.equal(r.ok, true);
  assert.equal(r.price, 16.95);
  assert.equal(r.currency, "SGD");
  assert.equal(r.available, true);
  assert.equal(r.variants[0].state, STATE.IN_STOCK);
  assert.equal(r.variants[0].id, "B0BZJ512J2", "the ASIN is the variant — that's how Amazon does sizes");
});

test("titles are decoded, not shown as raw entities", () => {
  const r = parseAmazon(FIXTURE, ITEM);
  assert.doesNotMatch(r.variants[0].label, /&#\d+;|&amp;|&quot;/);
  assert.match(r.variants[0].label, /Men's/, "apostrophe should be an apostrophe");
});

test("a blocked shell is refused rather than parsed as empty", () => {
  const r = parseAmazon("<html><head><title>Server Busy</title></head><body></body></html>", ITEM);
  assert.equal(r.ok, false);
  assert.match(r.message, /productTitle/);
});

test("availability prose maps to stock states", () => {
  assert.equal(stateFromAvailability("In stock"), STATE.IN_STOCK);
  assert.equal(stateFromAvailability("Only 3 left in stock - order soon."), STATE.LOW_STOCK);
  assert.equal(stateFromAvailability("Currently unavailable."), STATE.OUT_OF_STOCK);
  assert.equal(stateFromAvailability("We don't know when or if this item will be back"), STATE.OUT_OF_STOCK);
  // Unrecognised wording must be "I don't know", NOT "sold out" — guessing
  // sold-out would fire a false alert and then go permanently quiet.
  assert.equal(stateFromAvailability("some phrasing we've never seen"), null);
  assert.equal(stateFromAvailability("Auf Lager"), null, "German is not English");
  assert.equal(stateFromAvailability(""), null);
});

test("ASIN and marketplace come out of the URL", () => {
  assert.equal(asinOf("https://www.amazon.sg/dp/B0BZJ512J2"), "B0BZJ512J2");
  assert.equal(asinOf("https://www.amazon.com/gp/product/B00B17E8GI/ref=x"), "B00B17E8GI");
  assert.equal(asinOf("https://www.amazon.sg/s?k=shirt"), null);
  assert.equal(marketplaceOf("https://www.amazon.sg/dp/X"), "sg");
  assert.equal(marketplaceOf("https://www.amazon.co.uk/dp/X"), "co.uk");
});

// The link Wilson actually sent, junk and all.
test("a real shared Amazon link canonicalises to /dp/{ASIN}", () => {
  const messy = "https://www.amazon.sg/Champion-One-Point-Embroidered-C3-P300Z-C3-X352L/dp/B0BZJ512J2/ref=zg_bs_c_fashion_d_sccl_1/358-9192222-3991217?pd_rd_w=CrDKi&content-id=amzn1.sym.14b&pf_rd_r=Q9NS&pd_rd_i=B0BZJ7W3JB&th=1&psc=1";
  assert.equal(normalizeUrl(messy), "https://www.amazon.sg/dp/B0BZJ512J2");
});

test("two people sharing the same item create ONE product row", () => {
  const a = "https://www.amazon.sg/Some-Title/dp/B0BZJ512J2/ref=abc?th=1";
  const b = "https://www.amazon.sg/dp/B0BZJ512J2?pd_rd_i=B0BZJ7W3JB&psc=1";
  assert.equal(normalizeUrl(a), normalizeUrl(b));
});

test("entity decoding handles the double-encoded case too", () => {
  assert.equal(decodeEntities("Men&#39;s"), "Men's");
  assert.equal(decodeEntities("Levi&amp;#39;s"), "Levi's");
  assert.equal(decodeEntities("Coat &ndash; Navy"), "Coat – Navy");
  assert.equal(decodeEntities("A &amp; B"), "A & B");
});

const OOS = readFileSync(new URL("./fixtures/amazon-sg-unavailable.html", import.meta.url), "utf8");

test("a genuinely unavailable item parses as out of stock, with no price", () => {
  const r = parseAmazon(OOS, { url: "https://www.amazon.sg/dp/B0BDHWDR12" });
  assert.equal(r.ok, true);
  assert.equal(r.available, false);
  assert.equal(r.variants[0].state, "out_of_stock");
  assert.equal(r.price, undefined, "Amazon shows no price on an unavailable item");
});

test("wording we can't classify is a SOFT failure, not a false sold-out", () => {
  const german = '<html><span id="productTitle">Hemd</span>'
    + '<span class="primary-availability-message">Auf Lager</span></html>';
  const r = parseAmazon(german, { url: "https://www.amazon.de/dp/B0BZJ512J2" });
  assert.equal(r.ok, false);
  assert.equal(r.kind, "soft");
  assert.match(r.message, /non-English marketplace/);
});

test("a non-English Amazon link is refused at /add rather than tracked", async () => {
  const { resolveSelector } = await import("../supabase/functions/_shared/resolve.mjs");
  const r = resolveSelector("https://www.amazon.de/dp/B0BZJ512J2", "amazon");
  assert.equal(r.ok, false);
  assert.match(r.reason, /English/);
  assert.equal(resolveSelector("https://www.amazon.sg/dp/B0BZJ512J2", "amazon").ok, true);
});

// ── other categories: our parser was built from a T-SHIRT ────────────────────
// Wilson's question was whether one item per store is enough. For HTML-parsed
// stores it isn't — so these pin two categories that look nothing like apparel.
const BOOK = readFileSync(new URL("./fixtures/amazon-book.html", import.meta.url), "utf8");
const CLIPPERS = readFileSync(new URL("./fixtures/amazon-clippers.html", import.meta.url), "utf8");

test("amazon: a BOOK parses (different category, same markup contract)", () => {
  const r = parseAmazon(BOOK, { url: "https://www.amazon.sg/dp/0393356256" });
  assert.equal(r.ok, true);
  assert.equal(r.price, 28.72);
  assert.equal(r.currency, "SGD");
  assert.equal(r.variants[0].state, "low_stock", "Amazon told us stock was running down");
  assert.match(r.variants[0].label, /Odyssey/);
});

test("amazon: a homeware item parses", () => {
  const r = parseAmazon(CLIPPERS, { url: "https://www.amazon.sg/dp/B00B17E8GI" });
  assert.equal(r.ok, true);
  assert.equal(r.price, 11.04, "matches what a vendor's structured Amazon API returned independently");
  assert.equal(r.variants[0].available, true);
});
