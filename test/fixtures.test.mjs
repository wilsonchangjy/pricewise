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
  assert.equal(r.available, true);
});

test("every fixture is small enough to read in a diff", () => {
  const budget = 12_000; // bytes
  for (const f of ["shopify-drmartens.json", "uniqlo-l2s.json", "mango-prices.json",
                   "mango-stock.json", "cos-item.json", "jsonld-product.html",
                   "wix-product.html", "amazon-sg-product.html", "amazon-sg-unavailable.html",
                   "bershka-itxrest.json", "stradivarius-itxrest.json", "inditex-massimodutti.html",
                   "stories-product.html", "zara-productgroup.html", "asos-product.json"]) {
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
