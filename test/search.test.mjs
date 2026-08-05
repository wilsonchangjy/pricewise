import { test } from "node:test";
import assert from "node:assert/strict";
import { searchStore, domainGuesses, rankCandidates, findProduct, MAX_CANDIDATES } from "../supabase/functions/_shared/search.mjs";
import { STATE } from "../supabase/functions/_shared/stock.mjs";

// A fake fetch, so none of this touches the network.
const fakeFetch = (routes) => async (url) => {
  const hit = Object.entries(routes).find(([frag]) => String(url).includes(frag));
  if (!hit) return { ok: false, status: 404, text: async () => "" };
  return { ok: true, status: 200, text: async () => hit[1] };
};

// Shapes captured from the live endpoints on 2026-07-27.
const SHOPIFY = JSON.stringify({
  resources: { results: { products: [
    { title: "Wave Bottom Midnight Black", handle: "wave-bottom-midnight-black-1", url: "/products/wave-bottom-midnight-black-1?_pos=1", price: "45.00" },
    { title: "Palm Bottom White Pearl", handle: "palm-bottom-white-pearl", url: "/products/palm-bottom-white-pearl", price: "55.00" },
  ] } },
});
const WOO = JSON.stringify([
  { name: "Scarlett White Dress", permalink: "https://goshopia.com/shop/womenswear/dress/scarlett-white-dress/" },
]);

test("a shop's own search engine does the fuzzy matching for us", async () => {
  const hits = await searchStore("https://anane.co", "wave bottom", { fetchImpl: fakeFetch({ "search/suggest.json": SHOPIFY }) });
  assert.equal(hits.length, 2);
  assert.match(hits[0].url, /^https:\/\/anane\.co\/products\/wave-bottom/);
  assert.equal(hits[0].hint, "Wave Bottom Midnight Black");
});

test("WooCommerce answers the same question on a different route", async () => {
  const hits = await searchStore("https://goshopia.com", "dress", { fetchImpl: fakeFetch({ "wc/store/v1/products": WOO }) });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].url, "https://goshopia.com/shop/womenswear/dress/scarlett-white-dress/");
});

test("a shop on neither platform yields nothing — not a wrong guess", async () => {
  const hits = await searchStore("https://ourlegacy.com", "camion", { fetchImpl: fakeFetch({}) });
  assert.deepEqual(hits, [], "Our Legacy runs on Centra; returning nothing is the honest answer");
});

test("brand words become domain guesses, longest first", () => {
  const g = domainGuesses("Our Legacy Camion Boots in Black");
  assert.ok(g.includes("https://www.ourlegacycamion.com"));
  assert.ok(g.includes("https://www.ourlegacy.com"));
  assert.ok(g.some((u) => u.endsWith("ourlegacy.co")), "some DTC brands are .co");
});

// Ranking is by AVAILABILITY, never price. Comparing GBP 290 / USD 495 / SGD 690
// needs an FX rate and a view on duties — and this project has been caught out
// three times by stores' own currency claims.
test("candidates rank by availability, and by YOUR size when we know it", () => {
  const mk = (label, available, price, currency) => ({
    url: `https://x.test/${label}`,
    reading: { ok: true, price, currency, available, variants: [{ label: "M", available, state: available ? STATE.IN_STOCK : STATE.OUT_OF_STOCK }] },
  });
  const cheapButGone = mk("cheap", false, 100, "USD");
  const dearButThere = mk("dear", true, 900, "GBP");
  const ranked = rankCandidates([cheapButGone, dearButThere], { size: "M" });
  assert.equal(ranked[0].url, "https://x.test/dear", "in stock beats cheap — we can't compare currencies honestly");
});

test("the pipeline verifies every candidate and caps the list", async () => {
  // A source that suggests one real URL and two that no adapter can read.
  const source = async () => ([
    { url: "https://goshopia.com/shop/womenswear/dress/scarlett-white-dress/", hint: "real" },
    { url: "https://nowhere.invalid/product/ghost", hint: "hallucinated" },
    { url: "http://127.0.0.1/admin", hint: "hostile" },
  ]);
  const out = await findProduct("scarlett dress", {
    sources: [source],
    fetchImpl: async () => ({ ok: false, status: 404, text: async () => "" }),
  });
  assert.ok(Array.isArray(out));
  assert.ok(out.length <= MAX_CANDIDATES);
  // Nothing was readable through a real adapter, so nothing is shown. A
  // suggested URL that we cannot verify must never reach the user.
  assert.equal(out.length, 0);
});
