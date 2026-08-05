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

// ── the model source ────────────────────────────────────────────────────────
// It costs the user real money, so WHEN it runs is as much a design decision as
// what it returns.

test("no model key means no model source — the free path is the whole pipeline", async () => {
  const { sourcesFor, storeSearchSource } = await import("../supabase/functions/_shared/search.mjs");
  assert.deepEqual(sourcesFor({}), [storeSearchSource]);
  assert.equal(sourcesFor({ ai: { apiKey: "sk-ant-x" } }).length, 2);
});

// Adapters reach the network through fetcher.httpGet, which takes no injectable
// fetch — so an adapter READ (as opposed to detection) can only be held offline
// by swapping the global. Worth doing rather than skipping: without it these
// tests would quietly depend on shop.test resolving, and one earlier version of
// this file spent 20s per assertion waiting on a real timeout.
async function offline(routes, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const hit = Object.entries(routes).find(([frag]) => String(url).includes(frag));
    return hit
      ? { ok: true, status: 200, url: String(url), headers: new Headers(), text: async () => hit[1] }
      : { ok: false, status: 404, url: String(url), headers: new Headers(), text: async () => "" };
  };
  try { return await fn(globalThis.fetch); } finally { globalThis.fetch = real; }
}

const SHOPIFY_PRODUCT = JSON.stringify({
  title: "Found Free", price: 4500,
  variants: [{ id: 1, title: "M", available: true, price: 4500 }],
});

// The stopping condition is "enough VERIFIED results", not "a source answered" —
// a free hit that turns out to be a dead page must still fall through to the
// model the user is paying for, and a free hit that reads must not bill them.
test("a free hit that VERIFIES means the model is never billed", async () => {
  const { findProduct } = await import("../supabase/functions/_shared/search.mjs");
  let modelCalls = 0;
  const free = async () => ([{ url: "https://shop.test/products/a", hint: "found free" }]);
  const paid = async () => { modelCalls++; return []; };

  const out = await offline({ "/products/a.js": SHOPIFY_PRODUCT }, (f) =>
    findProduct("anything", { sources: [free, paid], max: 1, fetchImpl: f }));

  assert.equal(out.length, 1, "a real, readable product page");
  assert.equal(modelCalls, 0, "a readable free hit must not spend the user's model credits");
});

test("a free hit that turns out to be unreadable still falls through to the model", async () => {
  const { findProduct } = await import("../supabase/functions/_shared/search.mjs");
  let modelCalls = 0;
  const free = async () => ([{ url: "https://shop.test/products/ghost", hint: "" }]);
  const paid = async () => { modelCalls++; return []; };

  await offline({}, (f) => findProduct("anything", { sources: [free, paid], fetchImpl: f }));
  assert.equal(modelCalls, 1, "returning a dead URL is not the same as delivering");
});

test("the model source reports WHY it failed instead of looking like 'no results'", async () => {
  const { aiSearchSource } = await import("../supabase/functions/_shared/search.mjs");
  const hits = await aiSearchSource("camion boots", {
    ai: { apiKey: "sk-ant-x", provider: "anthropic" },
    aiFetchImpl: async () => ({ ok: false, status: 401, text: async () => "{}" }),
  });
  assert.deepEqual([...hits], []);
  assert.match(hits.note, /key was rejected/);
});

test("a model's suggestions are verified like anyone else's — no shortcut", async () => {
  const { findProduct } = await import("../supabase/functions/_shared/search.mjs");
  // A perfectly plausible, entirely fictional product page on a real brand's
  // real shop. (Kept to a free-platform host so the fake fetch governs it —
  // a bot-protected host would send the adapter to the live network.)
  const paid = async () => ([{ url: "https://www.ourlegacy.com/products/camion-boot-black", hint: "Camion Boots" }]);
  const out = await offline({}, (f) => findProduct("our legacy camion boots", { sources: [paid], fetchImpl: f }));
  assert.equal(out.length, 0, "unreadable is unreportable, whoever suggested it");
});

// ── the wrong country's site ────────────────────────────────────────────────
// Retailers split two ways and the split is the whole problem. END/Farfetch ship
// worldwide from ONE site, so their URL is already right. Castlery/Uniqlo/IKEA run
// a SEPARATE site per country, where the US page is a different price, different
// stock, often not shippable — technically the product, practically nothing.
// Live case: "Castlery Joseph bed" returned castlery.com/us at USD 1169 to a
// shopper in Singapore.

test("a foreign country's page proposes the shopper's own as an extra candidate", async () => {
  const { localeTwins } = await import("../supabase/functions/_shared/search.mjs");
  assert.deepEqual(
    localeTwins("https://www.castlery.com/us/products/joseph-bed?bed_frame_size=queen", "SG"),
    [{ url: "https://www.castlery.com/sg/products/joseph-bed?bed_frame_size=queen", hint: "" }],
    "same path, your country — a guess, but one that must still survive verification",
  );
});

test("a single-site international retailer is left alone", async () => {
  const { localeTwins } = await import("../supabase/functions/_shared/search.mjs");
  // No country in the URL: Farfetch/SSENSE-shaped. Nothing to swap, nothing wrong.
  assert.deepEqual(localeTwins("https://www.ssense.com/en-sg/men/product/x/1234", "SG"), []);
  // Already yours.
  assert.deepEqual(localeTwins("https://www.castlery.com/sg/products/joseph-bed", "SG"), []);
  // We don't know where they are, so we don't get an opinion.
  assert.deepEqual(localeTwins("https://www.castlery.com/us/products/joseph-bed", undefined), []);
});

test("buyable-where-you-are outranks in-stock-somewhere-else", async () => {
  const { rankCandidates } = await import("../supabase/functions/_shared/search.mjs");
  const mk = (url, country, available) => ({
    url, country, reading: { ok: true, price: 1, currency: "X", available, variants: [] },
  });
  const ranked = rankCandidates(
    [mk("https://x.test/us/p", "US", true), mk("https://x.test/sg/p", "SG", false)],
    { country: "SG" },
  );
  assert.equal(ranked[0].url, "https://x.test/sg/p",
    "an out-of-stock bed you could actually buy beats an in-stock one you can't");

  // A page with no country is every international retailer — never penalised.
  const neutral = rankCandidates(
    [mk("https://x.test/us/p", "US", true), mk("https://ssense.test/p", undefined, true)],
    { country: "SG" },
  );
  assert.equal(neutral[0].url, "https://ssense.test/p");
});
