// Adapters tested against REAL captured responses, not shapes I invented.
//
// This exists because of what the Amazon fixture caught: a parser that looked
// correct on the full live page was reading the wrong element entirely, and only
// failed once the page was trimmed to the part that mattered. Hand-written test
// shapes can't catch that — they encode the same assumption the parser makes.
//
// Every number below was returned by the live site on 2026-07-21. Captures were
// trimmed (Wix: 2.09MB -> 6KB) and contain no cookies or session data.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { parseShopifyJs } from "../supabase/functions/_shared/adapters/shopify.mjs";
import { parseUniqlo } from "../supabase/functions/_shared/adapters/uniqlo.mjs";
import { parseMango } from "../supabase/functions/_shared/adapters/mango.mjs";
import { parseCos } from "../supabase/functions/_shared/adapters/cos.mjs";
import { parseJsonLd } from "../supabase/functions/_shared/adapters/jsonld.mjs";
import { parseWix } from "../supabase/functions/_shared/adapters/wix.mjs";
import { normalizeUrl } from "../supabase/functions/_shared/urlguard.mjs";

const fx = (f) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8");
const json = (f) => JSON.parse(fx(f));

test("shopify: Dr Martens Oxford, SGD 295.99, per-variant availability", () => {
  const r = parseShopifyJs(json("shopify-drmartens.json"), { label: "Dr Martens", currency: "SGD" });
  assert.equal(r.ok, true);
  assert.equal(r.price, 295.99);
  assert.equal(r.currency, "SGD");
  assert.equal(r.variants.length, 4);
  assert.ok(r.variants.every((v) => typeof v.available === "boolean"), "every size needs a real boolean");
  assert.ok(r.variants.every((v) => v.label), "sizes must be labelled or /size can't match them");
});

test("uniqlo: the SELECTED colour+size wins, not the first row", () => {
  const item = { label: "Uniqlo", variantSelector: { colorDisplayCode: "69", sizeDisplayCode: "032" } };
  const r = parseUniqlo(json("uniqlo-l2s.json"), item);
  assert.equal(r.ok, true);
  assert.equal(r.price, 59.9);
  assert.equal(r.currency, "SGD");
  assert.equal(r.variants.length, 4);
});

test("uniqlo: a size that doesn't exist is REFUSED, never silently substituted", () => {
  const r = parseUniqlo(json("uniqlo-l2s.json"), {
    label: "Uniqlo", variantSelector: { colorDisplayCode: "69", sizeDisplayCode: "999" },
  });
  assert.equal(r.ok, false);
  assert.match(r.message, /not in l2s/);
});

test("mango: price from one API, per-size stock from another", () => {
  const r = parseMango(json("mango-prices.json"), json("mango-stock.json"), {
    label: "Mango", url: "https://shop.mango.com/sg/en/p/x", variantSelector: { color: "07", sizeCode: "20" },
  });
  assert.equal(r.ok, true);
  assert.equal(r.price, 65.9);
  assert.equal(r.currency, "SGD");
  assert.ok(r.compareAtPrice > r.price, "99.90 was the pre-sale price");
  assert.ok(r.variants.length >= 4);
});

test("cos: sizes for the chosen colour, with real stock", () => {
  const r = parseCos(json("cos-item.json"), {
    label: "COS", url: "https://www.cos.com/en-sg/x", variantSelector: { code: "1326785001", size: "S" },
  });
  assert.equal(r.ok, true);
  assert.equal(r.currency, "SGD");
  assert.equal(r.variants.length, 3);
  assert.ok(r.variants.every((v) => v.sizeCode), "size codes drive /size matching");
});

test("jsonld: generic fallback reads a real product page", () => {
  const r = parseJsonLd(fx("jsonld-product.html"), { label: "Swedish Stockings", currency: "EUR" });
  assert.equal(r.ok, true);
  assert.equal(r.price, 22.4);
  assert.equal(r.available, true);
});

test("wix: product state survives extraction from a 2MB page", () => {
  const r = parseWix(fx("wix-product.html"), { label: "munimuni" });
  assert.equal(r.ok, true);
  assert.equal(r.price, 5000);
  assert.equal(r.currency, "PHP", "currency comes from the shop, not our locale");
  // This page reports inventory.status "in_stock" alongside quantity 0 and
  // isInStock false. Reading status alone called a sold-out item available.
  assert.equal(r.available, false, "quantity 0 means sold out, whatever status claims");
});

test("every fixture is small enough to read in a diff", () => {
  const budget = 12_000; // bytes
  for (const f of ["shopify-drmartens.json", "uniqlo-l2s.json", "mango-prices.json",
                   "mango-stock.json", "cos-item.json", "jsonld-product.html",
                   "wix-product.html", "amazon-sg-product.html", "amazon-sg-unavailable.html",
                   "bershka-itxrest.json", "stradivarius-itxrest.json", "inditex-massimodutti.html",
                   "stories-product.html", "zara-productgroup.html", "asos-product.json",
                   "uniqlo-soldout.json", "shopify-soldout.json",
                   "farfetch-productgroup.html", "ssense-product.html",
                   "amazon-book.html", "amazon-clippers.html", "wix-multivariant.html",
                   "mrporter-productgroup.html"]) {
    assert.ok(fx(f).length < budget, `${f} is ${fx(f).length}b — trim it further`);
  }
});

// ── defended adapters, captured through the unblocker on 2026-07-21 ──────────
import { parseInditex } from "../supabase/functions/_shared/adapters/inditex.mjs";
import { parseStories } from "../supabase/functions/_shared/adapters/stories.mjs";
import { parseAsos } from "../supabase/functions/_shared/adapters/asos.mjs";

const asScript = (o) => `<script type="application/json">${JSON.stringify(o)}</script>`;

// THE CASE THAT CAUGHT A PRODUCTION BUG: every size of this live Bershka product
// is COMING_SOON, and the vocabulary guard rejected the whole product as "stock
// field changed" — a state we understand, refused for being the only one present.
test("bershka: an all-COMING_SOON product parses instead of being refused", () => {
  const r = parseInditex(asScript(json("bershka-itxrest.json")), { label: "Bershka", currency: "SGD" });
  assert.equal(r.ok, true);
  assert.equal(r.available, false, "coming soon is not buyable yet");
  assert.deepEqual([...new Set(r.variants.map((v) => v.state))], ["coming_soon"]);
  assert.deepEqual(r.variants.map((v) => v.label), ["S", "M", "L"]);
});

test("inditex: a genuinely renamed stock field is STILL refused", () => {
  const r = parseInditex(asScript({ sizes: [{ sku: 1, name: "M", visibilityValue: "SOMETHING_NEW" }] }), { label: "x" });
  assert.equal(r.ok, false);
  assert.match(r.message, /unrecognised visibilityValue/);
});

test("stradivarius: itxrest sizes parse with prices", () => {
  const r = parseInditex(asScript(json("stradivarius-itxrest.json")), { label: "Strad", currency: "EUR" });
  assert.equal(r.ok, true);
  assert.equal(r.price, 29.99);
  assert.equal(r.variants.length, 4);
});

test("massimo dutti: mixed sold-out and in-stock sizes from one page", () => {
  const r = parseInditex(fx("inditex-massimodutti.html"), { label: "MD", currency: "SGD" });
  assert.equal(r.ok, true);
  assert.equal(r.price, 69);
  const states = new Set(r.variants.map((v) => v.state));
  assert.ok(states.has("in_stock") && states.has("out_of_stock"), "the mix is the point — per-size stock is the wedge");
});

test("& Other Stories: per-size array plus JSON-LD price", () => {
  const r = parseStories(fx("stories-product.html"), { label: "OS", currency: "USD" });
  assert.equal(r.ok, true);
  assert.equal(r.price, 219);
  assert.equal(r.variants.length, 4);
});

test("zara: ProductGroup gives real per-size availability", () => {
  const r = parseJsonLd(fx("zara-productgroup.html"), { label: "Zara", currency: "SGD" });
  assert.equal(r.ok, true);
  assert.equal(r.price, 39.9);
  assert.equal(r.available, false, "this one was sold out when captured");
  assert.equal(r.variants.length, 4);
});

test("asos: summaries + stockprice merge, with the shop's low-stock flag", () => {
  const a = json("asos-product.json");
  const r = parseAsos(a.summaries, a.stockprice, { label: "ASOS", currency: "SGD" });
  assert.equal(r.ok, true);
  assert.equal(r.price, 94.99);
  assert.ok(new Set(r.variants.map((v) => v.state)).has("low_stock"), "ASOS tells us 'nearly gone' and we keep it");
});

test("asos: a wrong-currency response is refused, not mislabelled", () => {
  const a = json("asos-product.json");
  const r = parseAsos(a.summaries, a.stockprice, { label: "ASOS", currency: "USD" });
  assert.equal(r.ok, false);
  assert.match(r.message, /wrong store/);
});

// ── sold-out states, captured 2026-07-21 from links Wilson sent ──────────────
test("uniqlo: a sold-out size reports unavailable while siblings are in stock", () => {
  const r = parseUniqlo(json("uniqlo-soldout.json"), {
    label: "Uniqlo", variantSelector: { colorDisplayCode: "00", sizeDisplayCode: "005" },
  });
  assert.equal(r.ok, true);
  assert.equal(r.available, false, "the SELECTED size is out, whatever the others do");
  assert.ok(r.variants.some((v) => v.available), "and other sizes are still in stock");
});

test("uniqlo: STOCK_OUT is understood (not just OUT_OF_STOCK)", () => {
  // The live response used STOCK_OUT — a vocabulary we hadn't seen before today.
  const r = parseUniqlo(json("uniqlo-soldout.json"), { label: "Uniqlo" });
  const target = r.variants.find((v) => v.sizeCode === "005");
  assert.equal(target.state, "out_of_stock");
  assert.equal(target.available, false);
});

// THE BUG THIS CAUGHT: a link to a sold-out XS on a product whose other sizes are
// in stock. Tracking the product reports "available"; tracking the linked variant
// reports the truth. Ignoring ?variant= silently broke the entire promise.
test("shopify: the ?variant= in a link is the size the user meant", () => {
  const fixture = json("shopify-soldout.json");
  const whole = parseShopifyJs(fixture, { label: "Frankies", currency: "USD" });
  const chosen = parseShopifyJs(fixture, { label: "Frankies", currency: "USD", variantId: "44564022198341" });

  assert.equal(whole.available, true, "some size is available");
  assert.equal(chosen.available, false, "but the size they linked is NOT");
  assert.notEqual(whole.available, chosen.available, "which is exactly why the variant must be honoured");
});

test("shopify: resolveSelector extracts the variant from a real shared link", async () => {
  const { resolveSelector } = await import("../supabase/functions/_shared/resolve.mjs");
  const shared = "https://frankiesbikinis.com/products/autumn-underwire-bikini-top-sweet-bloom?_pos=1&_fid=201cc98df&_ss=c&variant=44564022198341";
  const r = resolveSelector(shared, "shopify");
  assert.equal(r.ok, true);
  assert.equal(r.variantId, "44564022198341");
  assert.match(r.watching, /exact size/);
});

test("shopify: search-context junk is stripped, but variant is kept", () => {
  const a = normalizeUrl("https://frankiesbikinis.com/products/x?_pos=1&_fid=abc&_ss=c&variant=123");
  const b = normalizeUrl("https://frankiesbikinis.com/products/x?variant=123&_pos=9");
  assert.equal(a, b, "the same item found two ways is one product");
  assert.match(a, /variant=123/, "variant names a size — never strip it");
});

// ── stores probed for feasibility 2026-07-21, both readable at 1 credit ──────
test("farfetch: per-size stock AND price, via priceSpecification[]", () => {
  // Farfetch ships price inside an ARRAY of UnitPriceSpecification. Handling only
  // the object form meant reading a page with per-size stock and no price at all.
  const r = parseJsonLd(fx("farfetch-productgroup.html"), { label: "Farfetch" });
  assert.equal(r.ok, true);
  assert.equal(r.price, 429);
  assert.equal(r.currency, "SGD", "the SG site quotes SGD — currency must follow the page");
  assert.deepEqual(r.variants.map((v) => v.label), ["S", "M", "L", "XL"]);
});

test("ssense: product-level only — no per-size stock available", () => {
  const r = parseJsonLd(fx("ssense-product.html"), { label: "SSENSE" });
  assert.equal(r.ok, true);
  assert.equal(r.price, 154);
  assert.equal(r.variants.length, 1, "SSENSE ships no hasVariant, so no per-size wedge here");
});

test("wix: per-size stock from a managed-variant product", () => {
  // munimuni's own catalogue, captured 2026-07-21: XS and S/M in stock,
  // L/XL and 2/3X at quantity zero. Reading only the product level said
  // "available" and lost every one of those distinctions.
  const r = parseWix(fx("wix-multivariant.html"), { label: "Yakap Top" });
  assert.equal(r.ok, true);
  assert.equal(r.currency, "PHP");
  assert.deepEqual(r.variants.map((v) => v.label), ["XS", "S/M", "L/XL", "2/3X"]);
  assert.deepEqual(r.variants.map((v) => v.available), [true, true, false, false]);
  assert.equal(r.available, true, "some size is buyable, so the product is");
});

test("wix: tracking a sold-out size reports IT, not the product", () => {
  const soldOut = parseWix(fx("wix-multivariant.html"), { label: "Yakap Top" })
    .variants.find((v) => v.label === "L/XL");
  const r = parseWix(fx("wix-multivariant.html"), { label: "Yakap Top", variantId: soldOut.id });
  assert.equal(r.available, false, "the whole point: my size is gone even though the product isn't");
});

test("farfetch: the wired adapter reuses the tested JSON-LD parser", async () => {
  // Verified live 2026-07-21: SGD 429, sizes S/M/L/XL, 1 credit on the plain tier.
  const { resolveSelector } = await import("../supabase/functions/_shared/resolve.mjs");
  const sel = resolveSelector("https://www.farfetch.com/sg/shopping/women/x-item-1.aspx", "farfetch");
  assert.equal(sel.ok, true);
  assert.deepEqual(sel.selector, {}, "sizes come from the page, so the URL needs nothing");

  const r = parseJsonLd(fx("farfetch-productgroup.html"), { label: "Farfetch" });
  assert.equal(r.price, 429);
  assert.equal(r.currency, "SGD");
  assert.deepEqual(r.variants.map((v) => v.label), ["S", "M", "L", "XL"]);
});

// Verified against Wilson's screenshot: £683 (was £975, 30% off), and of
// S/M/L/XL/XXL only M was available — the size grid matched exactly.
test("mrporter: per-size stock matches the page, and the was-price is captured", () => {
  const r = parseJsonLd(fx("mrporter-productgroup.html"), { label: "Stone Island jacket" });
  assert.equal(r.ok, true);
  assert.equal(r.price, 683);
  assert.equal(r.currency, "GBP", "GBP is what's charged; the page shows an approx SGD alongside");
  assert.equal(r.compareAtPrice, 975, "the strikethrough price rides in a second priceSpecification entry");
  assert.deepEqual(
    r.variants.map((v) => `${v.label}:${v.available ? "IN" : "out"}`),
    ["S:out", "M:IN", "L:out", "XL:out", "XXL:out"],
  );
  assert.equal(r.available, true, "one size left still counts as available");
});

test("jsonld: unquoted type attributes are still JSON-LD (eBay serves them)", () => {
  // HTML lets you omit attribute quotes and eBay does. Requiring them meant
  // silently finding no structured data at all on such a page.
  const unquoted = '<script type=application/ld+json>'
    + '{"@type":"Product","name":"X","offers":{"@type":"Offer","price":"9.99",'
    + '"priceCurrency":"USD","availability":"https://schema.org/InStock"}}</script>';
  const r = parseJsonLd(unquoted, { label: "x" });
  assert.equal(r.ok, true);
  assert.equal(r.price, 9.99);
});
