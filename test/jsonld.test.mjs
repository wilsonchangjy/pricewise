import { test } from "node:test";
import assert from "node:assert/strict";
import { titleOf, parseJsonLd } from "../supabase/functions/_shared/adapters/jsonld.mjs";

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

// ── the wrong product on the page ───────────────────────────────────────────
// Live failure 2026-08-05: the search returned an SSENSE /en-us/ URL for Our
// Legacy Camion Boots; the bot reported "OUR LEGACY Black Mini Jacket, USD 720"
// for a page that is Black Camion Boots at USD 760. The reader took the FIRST
// Product node on the page — fine on a product page, catastrophic on a listing
// page reached by a geo-redirect, where the first Product is whatever sits
// top-left in the grid.

const ldPage = (...products) =>
  products.map((p) => `<script type="application/ld+json">${JSON.stringify(p)}</script>`).join("\n");

const product = (name, url, price, sku) => ({
  "@type": "Product", name, url, ...(sku && { sku }),
  offers: { "@type": "Offer", price, priceCurrency: "USD", availability: "https://schema.org/InStock" },
});

const WANTED = "https://www.ssense.com/en-us/men/product/our-legacy/black-camion-boots/18122381";

test("with several products on the page, the requested one is chosen — not the first", () => {
  const html = ldPage(
    product("Black Mini Jacket", "/en-us/men/product/our-legacy/black-mini-jacket/17000001", 720),
    product("Black Camion Boots", "/en-us/men/product/our-legacy/black-camion-boots/18122381", 760),
  );
  const r = parseJsonLd(html, { url: WANTED });
  assert.equal(r.ok, true);
  assert.equal(r.price, 760, "the price on the page we asked for");
  assert.match(r.title, /Camion Boots/);
});

test("an id in the URL identifies the product when the node has no url", () => {
  const html = ldPage(
    product("Black Mini Jacket", null, 720, "17000001"),
    product("Black Camion Boots", null, 760, "18122381"),
  );
  assert.equal(parseJsonLd(html, { url: WANTED }).price, 760);
});

test("a listing page is REFUSED, not read as its first tile", () => {
  const html = ldPage(
    product("Black Mini Jacket", "/en-us/men/product/our-legacy/black-mini-jacket/17000001", 720),
    product("Grey Trousers", "/en-us/men/product/our-legacy/grey-trousers/17000002", 480),
  );
  const r = parseJsonLd(html, { url: WANTED });
  assert.equal(r.ok, false, "none of these is what we asked for");
  assert.equal(r.kind, "soft");
  assert.match(r.message, /none matches/);
});

test("the ordinary one-product page is untouched", () => {
  const html = ldPage(product("Black Camion Boots", "/whatever/else", 760));
  const r = parseJsonLd(html, { url: WANTED });
  assert.equal(r.ok, true, "a single product needs no identity proof — it's the only candidate");
  assert.equal(r.price, 760);
});
