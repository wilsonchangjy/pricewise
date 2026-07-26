import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseCettire, productTokenOf, stateFromCettire, hasCatalogState, jsonAfter } from "../supabase/functions/_shared/adapters/cettire.mjs";
import { normalizeUrl } from "../supabase/functions/_shared/urlguard.mjs";
import { STATE } from "../supabase/functions/_shared/stock.mjs";

const FIXTURE = readFileSync(new URL("./fixtures/cettire-product.html", import.meta.url), "utf8");
const URL_ = "https://www.cettire.com/sg/products/lemaire-croissant-small-shoulder-bag-928478783/cmVhY3Rpb24vcHJvZHVjdDpKYTZ4N0xlMzdDdTVCS1lCTA%3D%3D";

// Captured live 2026-07-26. Ground truth at capture: USD 1,077.65 reduced from
// 1,373.74, 19 in stock, one size.
test("parses the Apollo state: price, the sale it's on, and real stock", () => {
  const r = parseCettire(FIXTURE, { url: URL_ });
  assert.equal(r.ok, true);
  assert.equal(r.price, 1077.65);
  assert.equal(r.currency, "USD", "USD even on a /sg/ URL — don't infer SGD from the locale");
  assert.equal(r.compareAtPrice, 1373.74, "the was-price is what makes a discount visible");
  assert.equal(r.available, true);
  assert.equal(r.variants[0].state, STATE.IN_STOCK);
  assert.match(r.title, /Lemaire/);
});

test("the product token comes out of the path, URL-decoded", () => {
  assert.equal(productTokenOf(URL_), "cmVhY3Rpb24vcHJvZHVjdDpKYTZ4N0xlMzdDdTVCS1lCTA==");
  assert.equal(productTokenOf("https://www.cettire.com/sg/collections/bags"), null);
});

// THE TRAP THIS AVOIDS: the page's Apollo store also holds entries for related
// products. Reading "the first variant found" is the eBay-carousel bug again, so
// variants are matched on the token from the URL.
test("a variant belonging to another product is ignored", () => {
  const foreign = FIXTURE.replace(/"variantId":"[^"]+"/g, '"variantId":"cmVhY3Rpb24vcHJvZHVjdDpTT01FT05FRUxTRQ=="');
  const r = parseCettire(foreign, { url: URL_ });
  assert.equal(r.ok, false, "no variant matches this product, so refuse");
  assert.match(r.message, /no variants matched/);
});

// Cettire gives us BOTH a quantity and flags. The quantity wins — we shipped a
// sold-out item as available once by trusting a status field over its count.
test("stock states: the quantity outranks the flags", () => {
  assert.equal(stateFromCettire({ inventoryAvailableToSell: 19, isSoldOut: false }), STATE.IN_STOCK);
  assert.equal(stateFromCettire({ inventoryAvailableToSell: 2, isSoldOut: false }), STATE.LOW_STOCK);
  assert.equal(stateFromCettire({ inventoryAvailableToSell: 8, isLowQuantity: true }), STATE.LOW_STOCK);
  assert.equal(stateFromCettire({ inventoryAvailableToSell: 0, isSoldOut: false }), STATE.OUT_OF_STOCK,
    "zero available is sold out, whatever the flag says");
  assert.equal(stateFromCettire({ isSoldOut: true, inventoryAvailableToSell: 5 }), STATE.OUT_OF_STOCK);
  assert.equal(stateFromCettire({}), null, "an unrecognised shape is 'I don't know', never 'in stock'");
});

test("a page without the rendered catalogue state is refused, not guessed at", () => {
  assert.equal(hasCatalogState("<html><body>Just a challenge page</body></html>"), false);
  const r = parseCettire("<html><body>nothing here</body></html>", { url: URL_ });
  assert.equal(r.ok, false);
  assert.equal(r.kind, "parse");
});

// __NEXT_DATA__ is an assignment inside a normal <script>, so there's no closing
// tag to anchor on — a non-greedy regex truncated it half a megabyte in.
test("jsonAfter reads a balanced object, not up to the first brace it sees", () => {
  const s = 'x = {"a":{"b":"}"},"c":[1,2]} trailing';
  assert.deepEqual(JSON.parse(jsonAfter(s, "x =")), { a: { b: "}" }, c: [1, 2] });
  assert.equal(jsonAfter("no object here", "x ="), null);
});

// An ad link and a clean link are the same product; two rows means paying twice.
test("advertising junk is stripped so one product is one row", () => {
  const ad = URL_ + "?lng=en&utm_source=google&utm_medium=cpc&gclid=EAIaIQ&gad_source=1&gad_campaignid=995284531";
  assert.equal(normalizeUrl(ad), normalizeUrl(URL_));
  assert.equal(normalizeUrl(ad), "https://www.cettire.com/sg/products/lemaire-croissant-small-shoulder-bag-928478783/cmVhY3Rpb24vcHJvZHVjdDpKYTZ4N0xlMzdDdTVCS1lCTA%3D%3D");
});
