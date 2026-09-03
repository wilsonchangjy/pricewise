import { test } from "node:test";
import assert from "node:assert/strict";
import { displayTitle } from "../supabase/functions/_shared/label.mjs";
import { brandForHost, isOwnBrand } from "../supabase/functions/_shared/stores.mjs";
import { itemKeyboard } from "../supabase/functions/_shared/keyboards.mjs";

// "Unisex Smart Wide Straight Pants" on a list of eight tells you nothing about
// which shop it came from. The brand belongs in front — but only when the shop's
// name IS the brand.

const t = (title, url, adapter) => displayTitle({ title, url, adapter });

test("a single-brand shop puts its name in front", () => {
  assert.equal(t("Unisex Smart Wide Straight Pants", "https://www.uniqlo.com/sg/en/products/E1/00", "uniqlo"),
    "Uniqlo Unisex Smart Wide Straight Pants");
  assert.equal(t("Funnel Neck Blouson", "https://mutimer.co/products/x", "shopify"),
    "Mutimer Funnel Neck Blouson");
  assert.equal(t("Joseph Bed", "https://www.castlery.com/sg/products/joseph-bed", "jsonld"),
    "Castlery Joseph Bed");
});

test("a MARKETPLACE's name is not a brand, and its titles already carry the real one", () => {
  // "Farfetch LEMAIRE Small Croissant Bag" and "Ebay Vtg Carhartt Jacket" are
  // both worse than the bare title.
  assert.equal(t("LEMAIRE Small Croissant Bag In Leather", "https://www.farfetch.com/item-1.aspx", "farfetch"),
    "LEMAIRE Small Croissant Bag In Leather");
  assert.equal(t("Vtg Carhartt Jacket J97", "https://www.ebay.com/itm/318509998125", "ebay"),
    "Vtg Carhartt Jacket J97");
  assert.ok(!isOwnBrand("www.lookfantastic.com", "jsonld"), "THG beauty sites are multi-brand too");
});

test("a title already leading with the brand is left alone — no 'Uniqlo Uniqlo'", () => {
  assert.equal(t("Uniqlo Airism Tee", "https://www.uniqlo.com/sg/en/products/E2/00", "uniqlo"), "Uniqlo Airism Tee");
  assert.equal(t("vetsak", "https://vetsak.com/products/x", "shopify"), "vetsak");
});

test("brand matching ignores punctuation and case", () => {
  assert.equal(brandForHost("drmartens.com.sg"), "Dr. Martens");
  assert.equal(t("Dr Martens 1461", "https://drmartens.com.sg/products/x", "shopify"), "Dr Martens 1461");
});

test("a domain we can't read cleanly is left alone rather than mangled", () => {
  assert.equal(brandForHost("shop123.com"), undefined);
  assert.equal(t("Some Thing", "https://shop123.com/p/1", "shopify"), "Some Thing");
  assert.equal(t("Some Thing", "not a url", "shopify"), "Some Thing");
});

// ── the Market button only where a pin can change what we READ ───────────────
// Live: tapping 🌐 Market on Uniqlo / Dr Martens / LEMAIRE produced "Something
// went wrong" for a different reason (see the select fix), but even working it
// would have been a control that controls nothing — those pages decide their own
// storefront, and pinning would have written a currency label onto a price it
// could not move.

test("hiding Market drops the button without disturbing the rest of the card", () => {
  assert.deepEqual(itemKeyboard(1, { showMarket: false }).inline_keyboard.flat().map((b) => b.callback_data),
    ["s:1", "e:1", "t:1", "h:1", "r:1", "L"]);
  assert.deepEqual(itemKeyboard(1, { showMarket: true }).inline_keyboard.flat().map((b) => b.callback_data),
    ["s:1", "e:1", "t:1", "h:1", "m:1", "r:1", "L"]);
});
