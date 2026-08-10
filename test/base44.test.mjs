import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBase44, productIdOf, appIdOf, isBase44 } from "../supabase/functions/_shared/adapters/base44.mjs";
import { STATE } from "../supabase/functions/_shared/stock.mjs";

// Captured live from shoptsuchi.com 2026-08-10. This shop was ACCEPTED at /add
// and then failed every check: its HTML is a 6.7KB shell whose only JSON-LD is
// WebSite / Organization / BreadcrumbList. The catalogue lives at a public,
// unauthenticated endpoint instead.
const CATALOGUE = [
  { id: "6a4df8e2e22b690c07b63074", title: "Shell & Rose Petal Silk Necklace", price: 195.0, in_stock: true, size: "large", category: "necklaces" },
  { id: "aaaaaaaaaaaaaaaaaaaaaaaa", title: "Something Else", price: 88.0, in_stock: false, size: "small" },
];
const ITEM = { url: "https://shoptsuchi.com/product/6a4df8e2e22b690c07b63074", label: "" };

test("reads the product the URL names, out of the whole catalogue", () => {
  const r = parseBase44(CATALOGUE, ITEM);
  assert.equal(r.ok, true);
  assert.equal(r.price, 195);
  assert.equal(r.available, true);
  assert.equal(r.title, "Shell & Rose Petal Silk Necklace");
  assert.equal(r.variants[0].label, "large");
  assert.equal(r.variants[0].state, STATE.IN_STOCK);
});

// in_stock is a real boolean here, which is rare enough to lean on — but only
// an explicit true counts, per the rule that unknown is never "in stock".
test("only an explicit true is buyable", () => {
  const gone = parseBase44(CATALOGUE, { url: "https://shoptsuchi.com/product/aaaaaaaaaaaaaaaaaaaaaaaa" });
  assert.equal(gone.available, false);
  assert.equal(gone.variants[0].state, STATE.OUT_OF_STOCK);

  for (const odd of [undefined, null, "true", 1]) {
    const r = parseBase44([{ id: "b".repeat(24), title: "X", price: 10, in_stock: odd }], { url: "https://x.test/product/" + "b".repeat(24) });
    assert.equal(r.available, false, `in_stock=${JSON.stringify(odd)} must not read as buyable`);
  }
});

// No currency exists anywhere in the payload. Inventing one is how a tracker
// tells someone a wrong number.
test("no currency is published, and none is invented", () => {
  assert.equal(parseBase44(CATALOGUE, ITEM).currency, "");
  assert.equal(parseBase44(CATALOGUE, { ...ITEM, currency: "SGD" }).currency, "SGD", "an explicit override still wins");
});

test("a delisted product is a soft failure, not a parse error", () => {
  const r = parseBase44(CATALOGUE, { url: "https://shoptsuchi.com/product/" + "c".repeat(24) });
  assert.equal(r.ok, false);
  assert.equal(r.kind, "soft");
  assert.match(r.message, /isn't among them/);
});

test("a product with no price is refused rather than reported at zero", () => {
  const r = parseBase44([{ id: "d".repeat(24), title: "X", in_stock: true }], { url: "https://x.test/product/" + "d".repeat(24) });
  assert.equal(r.ok, false);
  assert.match(r.message, /no price/);
});

test("ids come from the URL, and the app id from the page's own asset links", () => {
  assert.equal(productIdOf(ITEM.url), "6a4df8e2e22b690c07b63074");
  assert.equal(productIdOf("https://shoptsuchi.com/products"), undefined, "a listing page names no product");
  assert.equal(
    appIdOf('<meta content="https://media.base44.com/images/public/69fa9cd23808f0e30b45fe77/logo.png">'),
    "69fa9cd23808f0e30b45fe77",
  );
  assert.ok(isBase44('<script src="https://base44.app/x.js">'));
  assert.ok(!isBase44("<html>a normal shop</html>"));
});
