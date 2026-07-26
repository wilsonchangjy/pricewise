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

// ── multi-size: the bug the one-size bag hid ─────────────────────────────────
// Every SIZE on Cettire is its own variant with its own token, so matching
// variants on the URL's token found exactly one — correct for a one-size bag,
// and silently 1-of-30 on a sneaker. The authoritative link is
// CatalogProduct.variants[]; the token only says which product owns them.
const MULTI = readFileSync(new URL("./fixtures/cettire-multisize.html", import.meta.url), "utf8");
// This URL points at IT35 — which is SOLD OUT. Captured live 2026-07-26.
const MULTI_URL = "https://www.cettire.com/sg/products/golden-goose-superstar/cmVhY3Rpb24vcHJvZHVjdDpiYk1pV21TeHYzRXVtU2poWg%3D%3D";

test("every size on the product is read, not just the one named in the link", () => {
  const r = parseCettire(MULTI, { url: MULTI_URL });
  assert.equal(r.ok, true);
  assert.equal(r.variants.length, 8, "all of the product's sizes, not the URL's single variant");
  const labels = r.variants.map((v) => v.label);
  assert.ok(labels.includes("IT35") && labels.includes("IT42"), "sizes span the range");
});

test("sold-out sizes are reported as such — that's the point of watching them", () => {
  const r = parseCettire(MULTI, { url: MULTI_URL });
  const bySize = Object.fromEntries(r.variants.map((v) => [v.label, v.available]));
  assert.equal(bySize["IT35"], false, "IT35 has zero inventory");
  assert.equal(bySize["IT40"], true);
  assert.ok(r.available, "the product is buyable even though the linked size isn't");
});

// Sizes are priced individually (IT35 at 220.89 vs IT44 at 519.51 on the live
// page). Quoting the cheapest of ANY size advertises a bargain you can't buy.
test("the headline price is the cheapest BUYABLE size, not the cheapest size", () => {
  const r = parseCettire(MULTI, { url: MULTI_URL });
  const cheapestBuyable = Math.min(...r.variants.filter((v) => v.available).map((v) => v.price));
  const cheapestAny = Math.min(...r.variants.map((v) => v.price));
  assert.equal(r.price, cheapestBuyable);
  assert.ok(cheapestAny < cheapestBuyable, "fixture must actually contain a cheaper sold-out size");
});
