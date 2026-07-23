import { test } from "node:test";
import assert from "node:assert/strict";
import { titleOf } from "../supabase/functions/_shared/adapters/jsonld.mjs";

// Farfetch ships only the bare product name in JSON-LD — "small Croissant bag in
// leather" — and the brand everyone recognises in a separate field. A share link
// carries no slug either, so without this the bot showed "Item .Aspx".
test("the brand is prepended when the JSON-LD name omits it", () => {
  assert.equal(
    titleOf({ name: "small Croissant bag in leather", brand: { "@type": "Brand", name: "LEMAIRE" } }),
    "LEMAIRE small Croissant bag in leather",
  );
  assert.equal(titleOf({ name: "big bag", brand: "LEMAIRE" }), "LEMAIRE big bag", "brand as a plain string");
});

test("a name that already leads with the brand isn't double-branded", () => {
  assert.equal(titleOf({ name: "LEMAIRE Croissant bag", brand: { name: "LEMAIRE" } }), "LEMAIRE Croissant bag");
  assert.equal(titleOf({ name: "Nike Air Max", brand: "nike" }), "Nike Air Max", "case-insensitive");
});

test("no brand, no name — sensible fallbacks", () => {
  assert.equal(titleOf({ name: "Plain shirt" }), "Plain shirt");
  assert.equal(titleOf({ name: "", brand: "X" }), undefined);
  assert.equal(titleOf({}), undefined);
});
