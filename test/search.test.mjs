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

// Live 2026-08-05: "Our Legacy Camion boots" filled two of three slots with the
// SAME boot at the SAME shop — endclothing.com/sg and endclothing.com/us — one
// of them flagged as the wrong country. Three slots is an answer; spending two
// on one product is a menu with a typo.
test("the same product on two country sites is ONE result, in your country", async () => {
  const { dedupeByProduct } = await import("../supabase/functions/_shared/search.mjs");
  const end = (c, price, cur) => ({
    url: `https://www.endclothing.com/${c}/our-legacy-camion-boot-cocbb.html`,
    country: c.toUpperCase(),
    reading: { ok: true, price, currency: cur, available: true, variants: [] },
  });
  // Ranking has already put SG first; dedupe keeps the first of each product.
  const out = dedupeByProduct([end("sg", 839, "SGD"), end("us", 705, "USD")]);
  assert.equal(out.length, 1);
  assert.equal(out[0].country, "SG");
});

test("two genuinely different products at one shop both survive", async () => {
  const { dedupeByProduct } = await import("../supabase/functions/_shared/search.mjs");
  const at = (slug) => ({ url: `https://www.endclothing.com/sg/${slug}.html`, country: "SG", reading: { ok: true } });
  assert.equal(dedupeByProduct([at("our-legacy-camion-boot-cocbb"), at("our-legacy-mini-jacket-xyz")]).length, 2);
  // ...and so do the same slug at two different retailers.
  assert.equal(dedupeByProduct([
    { url: "https://www.endclothing.com/sg/x.html", country: "SG", reading: {} },
    { url: "https://www.ssense.com/sg/x.html", country: "SG", reading: {} },
  ]).length, 2);
});

// SSENSE / MR PORTER / NET-A-PORTER spell the locale "en-us", not "us". That
// shape wasn't recognised at all, so an SSENSE US link read as "no country" —
// dodging BOTH the wrong-country warning and the swap to the local site. That's
// how a /en-us/ page reached a shopper in Singapore looking untroubled.
test("lang-COUNTRY locales are recognised and swapped, keeping the language", async () => {
  const { localeTwins } = await import("../supabase/functions/_shared/search.mjs");
  const { localeFromUrl } = await import("../supabase/functions/_shared/locale.mjs");
  const us = "https://www.ssense.com/en-us/men/product/our-legacy/black-camion-boots/18122381";

  assert.equal(localeFromUrl(us).country, "US");
  assert.equal(localeFromUrl(us).currency, "USD");
  assert.deepEqual(localeTwins(us, "SG"), [{
    url: "https://www.ssense.com/en-sg/men/product/our-legacy/black-camion-boots/18122381",
    hint: "",
  }]);
  assert.deepEqual(localeTwins("https://www.ssense.com/en-sg/men/product/x/1", "SG"), [],
    "already local — nothing to do");
});

// ── parallel verification + the credit cap ──────────────────────────────────
// Measured 2026-08-05: reading defended pages one after another took 5–8 MINUTES
// per search, of which the model was 25s. They're independent reads.
test("candidates are read together, not one after another", async () => {
  const { verifyCandidates } = await import("../supabase/functions/_shared/search.mjs");
  let inFlight = 0, peak = 0;
  const slowShopify = JSON.stringify({ title: "X", price: 100, variants: [{ id: 1, title: "M", available: true, price: 100 }] });

  const real = globalThis.fetch;
  globalThis.fetch = async (u) => {
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 40));
    inFlight--;
    return String(u).includes(".js")
      ? { ok: true, status: 200, url: String(u), headers: new Headers(), text: async () => slowShopify }
      : { ok: false, status: 404, url: String(u), headers: new Headers(), text: async () => "" };
  };
  try {
    const cands = ["a", "b", "c", "d"].map((s) => ({ url: `https://shop.test/products/${s}`, hint: "" }));
    const out = await verifyCandidates(cands, { fetchImpl: globalThis.fetch });
    assert.equal(out.length, 4);
    assert.ok(peak > 1, `reads must overlap — peak concurrency was ${peak}`);
  } finally { globalThis.fetch = real; }
});

// Parallel removes the LATENCY reason to stop early, but each defended read
// still spends the user's credits — so the number of them is bounded explicitly
// rather than falling out of whatever order the sources happened to return.
test("free shops are unlimited; bot-protected ones are capped", async () => {
  const { verifyCandidates } = await import("../supabase/functions/_shared/search.mjs");
  const reads = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (u) => {
    reads.push(String(u));
    return { ok: false, status: 404, url: String(u), headers: new Headers(), text: async () => "" };
  };
  try {
    // Five Zara URLs — all defended, all host-matched so no probe is needed.
    const cands = [1, 2, 3, 4, 5].map((n) => ({ url: `https://www.zara.com/sg/en/thing-p0${n}.html`, hint: "" }));
    await verifyCandidates(cands, { maxDefendedReads: 2 });
    const zaraReads = reads.filter((u) => u.includes("zara.com")).length;
    assert.ok(zaraReads <= 2, `capped at 2 defended reads, saw ${zaraReads}`);
  } finally { globalThis.fetch = real; }
});

// Price decides between LIKE FOR LIKE only. SGD 839 vs SGD 650 is a comparison a
// shopper can act on; SGD 650 vs GBP 455 needs an FX rate and a view on duties.
test("cheapest wins within one currency, and currencies are never converted", async () => {
  const { rankCandidates } = await import("../supabase/functions/_shared/search.mjs");
  const mk = (url, price, currency) => ({
    url, country: "SG",
    reading: { ok: true, price, currency, available: true, variants: [{ label: "M", available: true }] },
  });

  const ranked = rankCandidates(
    [mk("https://a.test/x", 839, "SGD"), mk("https://b.test/x", 650, "SGD")],
    { country: "SG" },
  );
  assert.equal(ranked[0].url, "https://b.test/x", "SGD 650 beats SGD 839");

  // A lone GBP result has nothing to be cheaper than, so price must not move it.
  const mixed = rankCandidates(
    [mk("https://sgd.test/x", 839, "SGD"), mk("https://gbp.test/x", 455, "GBP")],
    { country: "SG" },
  );
  assert.equal(mixed[0].url, "https://sgd.test/x", "a smaller number in another currency is not a lower price");
});

test("in stock still outranks cheaper — a bargain you can't buy isn't one", async () => {
  const { rankCandidates } = await import("../supabase/functions/_shared/search.mjs");
  const mk = (url, price, available) => ({
    url, country: "SG",
    reading: { ok: true, price, currency: "SGD", available, variants: [{ label: "M", available }] },
  });
  const ranked = rankCandidates([mk("https://gone.test/x", 100, false), mk("https://here.test/x", 900, true)], { country: "SG" });
  assert.equal(ranked[0].url, "https://here.test/x");
});

// ── caching ─────────────────────────────────────────────────────────────────
// A search costs the user a model call and up to three unblocker reads. The same
// search happens twice more often than you'd think: a retry after a failure, a
// corrected typo, or two people wanting the same thing.
test("word order, case and punctuation are all the same query", async () => {
  const { cacheKeyFor } = await import("../supabase/functions/_shared/search.mjs");
  const k = cacheKeyFor("Our Legacy Camion boots in black");
  assert.equal(cacheKeyFor("camion boots our legacy in BLACK!"), k);
  assert.equal(cacheKeyFor("  our legacy   camion boots in black  "), k);
  assert.notEqual(cacheKeyFor("our legacy camion boots in brown"), k);
});

test("a cache hit skips the FINDING and still reads every page", async () => {
  const { findProduct } = await import("../supabase/functions/_shared/search.mjs");
  const page = JSON.stringify({ title: "Cached", price: 100, variants: [{ id: 1, title: "M", available: true, price: 100 }] });

  let sourcesRan = 0;
  const source = async () => { sourcesRan++; return []; };
  const reads = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (u) => {
    reads.push(String(u));
    return String(u).includes(".js")
      ? { ok: true, status: 200, url: String(u), headers: new Headers(), text: async () => page }
      : { ok: false, status: 404, url: String(u), headers: new Headers(), text: async () => "" };
  };
  try {
    const out = await findProduct("anything at all", {
      sources: [source],
      cache: { get: async () => ([{ url: "https://shop.test/products/x", hint: "" }]), put: async () => {} },
    });
    assert.equal(out.length, 1);
    assert.equal(out.cached, true);
    assert.equal(sourcesRan, 0, "no model call, no shop search — that's the saving");
    assert.ok(reads.some((u) => u.includes("/products/x.js")), "the page is STILL read: a cached price would go stale");
  } finally { globalThis.fetch = real; }
});

test("a remembered URL that has since died falls through to a real search", async () => {
  const { findProduct } = await import("../supabase/functions/_shared/search.mjs");
  let sourcesRan = 0;
  const source = async () => { sourcesRan++; return []; };
  const real = globalThis.fetch;
  globalThis.fetch = async (u) => ({ ok: false, status: 404, url: String(u), headers: new Headers(), text: async () => "" });
  try {
    await findProduct("gone now", {
      sources: [source],
      cache: { get: async () => ([{ url: "https://shop.test/products/dead", hint: "" }]), put: async () => {} },
    });
    assert.equal(sourcesRan, 1, "a stale cache must not become a permanent 'not found'");
  } finally { globalThis.fetch = real; }
});

test("an empty result is never cached", async () => {
  const { findProduct } = await import("../supabase/functions/_shared/search.mjs");
  let wrote = 0;
  const real = globalThis.fetch;
  globalThis.fetch = async (u) => ({ ok: false, status: 404, url: String(u), headers: new Headers(), text: async () => "" });
  try {
    await findProduct("nothing here", {
      sources: [async () => ([{ url: "https://shop.test/products/nope", hint: "" }])],
      cache: { get: async () => null, put: async () => { wrote++; } },
    });
    // Caching a miss would turn one bad day at a retailer into a week of
    // "I couldn't find it" for everyone who asks.
    assert.equal(wrote, 0);
  } finally { globalThis.fetch = real; }
});
