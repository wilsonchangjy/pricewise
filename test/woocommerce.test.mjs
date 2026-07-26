import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildReading, variationsBlob, slugOf, money, labelOf } from "../supabase/functions/_shared/adapters/woocommerce.mjs";
import { STATE } from "../supabase/functions/_shared/stock.mjs";

const fx = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8");
const PRODUCT = JSON.parse(fx("woocommerce-product.json"));
const BLOB = variationsBlob(fx("woocommerce-variations.html"));
const ITEM = { url: "https://goshopia.com/shop/womenswear/dress/scarlett-white-dress/" };

// Captured live 2026-07-27. WooCommerce is the other huge long tail (~6.8M
// stores) and, like Shopify, answers without a key: the Store API at
// /wp-json/wc/store/v1/ is public and unauthenticated.
test("reads a variable product: price, the sale, and every size's stock", () => {
  const r = buildReading(PRODUCT, BLOB, ITEM);
  assert.equal(r.ok, true);
  assert.equal(r.price, 650);
  assert.equal(r.compareAtPrice, 800, "regular vs sale price is the discount signal");
  assert.equal(r.variants.length, 8);
  assert.deepEqual(r.variants.map((v) => v.label), ["2XS", "XS", "S", "M", "L", "XL", "XXL", "XXXL"]);
  assert.ok(r.variants.every((v) => v.state === STATE.IN_STOCK));
});

// ⚠️ THE TRAP: multi-currency stores (a very common plugin) emit inconsistent
// JSON-LD. On this very page the Store API reports AED, the page displays a
// converted "$217.83", and the JSON-LD carries the AED NUMBER under a USD
// LABEL — so parseJsonLd would call an 800 AED dress $800. currency_code is the
// only field that isn't guessing.
test("currency comes from the Store API, not the page's JSON-LD", () => {
  const r = buildReading(PRODUCT, BLOB, ITEM);
  assert.equal(r.currency, "AED");
});

// Prices arrive as integer MINOR UNITS with the exponent alongside.
test("minor units are converted, not read as whole numbers", () => {
  assert.equal(money({ price: "65000", currency_minor_unit: 2 }), 650);
  assert.equal(money({ price: "1500", currency_minor_unit: 3 }), 1.5);
  assert.equal(money({ price: "500" }), 5, "defaults to 2 decimal places");
  assert.equal(money({}), undefined);
});

test("a sold-out size is reported as such, and never sets the headline price", () => {
  const mixed = BLOB.map((v, i) =>
    i < 2 ? { ...v, is_in_stock: false, display_price: 100 } : v);
  const r = buildReading(PRODUCT, mixed, ITEM);
  assert.equal(r.variants[0].available, false);
  assert.equal(r.variants[0].state, STATE.OUT_OF_STOCK);
  assert.equal(r.price, 650, "the cheapest BUYABLE size — not the sold-out 100");
  assert.equal(r.available, true, "other sizes are still buyable");
});

test("stock flags we can't classify are refused, never rendered as sold out", () => {
  const unknown = BLOB.map((v) => ({ ...v, is_in_stock: undefined, is_purchasable: undefined }));
  const r = buildReading(PRODUCT, unknown, ITEM);
  assert.equal(r.ok, false);
  assert.equal(r.kind, "parse");
});

test("a simple product (no variations) still reads, product-level", () => {
  const simple = { ...PRODUCT, type: "simple", variations: [], is_in_stock: true, is_purchasable: true };
  const r = buildReading(simple, null, ITEM);
  assert.equal(r.ok, true);
  assert.equal(r.variants.length, 1);
  assert.equal(r.variants[0].label, "One size");
  assert.equal(r.available, true);
});

test("the product slug comes off the end of the permalink", () => {
  assert.equal(slugOf(ITEM.url), "scarlett-white-dress");
  assert.equal(slugOf("https://shop.test/product/blue-shirt"), "blue-shirt");
  assert.equal(slugOf("https://shop.test/"), null);
});

test("size labels survive whatever the store named its attribute", () => {
  assert.equal(labelOf({ attribute_size: "M" }), "M");
  assert.equal(labelOf({ attribute_pa_size: "UK 9" }), "UK 9");
  assert.equal(labelOf({ attribute_size: "M", attribute_colour: "Navy" }), "M / Navy");
  assert.equal(labelOf({}), null);
});
