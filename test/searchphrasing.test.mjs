import { test } from "node:test";
import assert from "node:assert/strict";
import { guessesWithRemainder, storeSearchSource, cacheKeyFor } from "../supabase/functions/_shared/search.mjs";

// LIVE, 2026-09-15. Two descriptions of the same skirt, down to the shop's own
// product name:
//   "Saria silk midi from Nol Collective, size S"  -> "I couldn't find it"
//   "Nol Collective Saria silk midi"               -> three results, two exact
// The shop's own search returned the Saria skirts for BOTH. The guesser only
// looked for a brand in the opening words, so the first phrasing never asked
// nolcollective.com at all.
const Q1 = "Saria silk midi from Nol Collective, size S";
const Q2 = "Nol Collective Saria silk midi";

// ── where the brand sits must not matter ─────────────────────────────────────

test("the brand after 'from' is guessed FIRST, and stripped from what we search for", () => {
  const [first] = guessesWithRemainder(Q1);
  assert.equal(first.name, "nolcollective");
  assert.equal(first.basis, "maker");
  assert.equal(first.remainder, "saria silk midi");
});

test("'by' names the maker just like 'from'", () => {
  assert.equal(guessesWithRemainder("funnel neck blouson by mutimer")[0].name, "mutimer");
});

test("a brand at the END with no 'from' is still guessed", () => {
  assert.ok(guessesWithRemainder("Saria silk midi Nol Collective").some((g) => g.name === "nolcollective"));
});

test("a brand at the START guesses exactly as it always did", () => {
  const names = guessesWithRemainder("Our Legacy Camion Boots in Black").map((g) => g.name);
  assert.deepEqual(names.slice(0, 3), ["ourlegacycamion", "ourlegacy", "our"]);
  assert.equal(guessesWithRemainder("Our Legacy Camion Boots in Black")[1].remainder, "camion boots in black");
});

test("brands that START with a small word survive — The Row, On Running", () => {
  assert.ok(guessesWithRemainder("The Row Margaux bag").some((g) => g.name === "therow"));
  assert.ok(guessesWithRemainder("On Running Cloudmonster").some((g) => g.name === "onrunning"));
  assert.ok(guessesWithRemainder("Margaux bag from The Row").some((g) => g.name === "therow" && g.basis === "maker"));
});

test("a trailing small word never becomes part of a brand ('…nol collective in')", () => {
  const names = guessesWithRemainder("Saria midi skirt from Nol Collective in scarlet").map((g) => g.name);
  assert.equal(names[0], "nolcollective");
  assert.ok(!names.some((n) => n.endsWith("in")));
});

test("a size is never a guess or a search term", () => {
  for (const g of guessesWithRemainder(Q1)) {
    assert.notEqual(g.name, "s");
    assert.ok(!/\bsize\b/.test(g.remainder), g.remainder);
  }
});

test("a COLOUR is kept — natural and scarlet linen are different products", () => {
  const [g] = guessesWithRemainder("Saria midi skirt from Nol Collective in scarlet");
  assert.match(g.remainder, /\bscarlet\b/);
});

// ── the cache sees the same query ────────────────────────────────────────────

test("both phrasings are one query to the cache", () => {
  assert.equal(cacheKeyFor(Q1), cacheKeyFor(Q2));
});

test("a size doesn't split the cache, a colour does", () => {
  assert.equal(cacheKeyFor("saria midi size S"), cacheKeyFor("saria midi size M"));
  assert.notEqual(cacheKeyFor("saria midi scarlet"), cacheKeyFor("saria midi natural"));
});

// ── asking every guess at once ───────────────────────────────────────────────
// A fake network: named origins answer as Shopify stores, anything listed in
// `hang` never answers until aborted, everything else is a 404.

const SUGGEST = /\/search\/suggest\.json$/;
function network({ products = {}, names = {}, delays = {}, hang = [] } = {}) {
  return async (url, { signal } = {}) => {
    const u = new URL(url);
    if (hang.includes(u.origin)) {
      return new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    }
    if (delays[u.origin]) await new Promise((r) => setTimeout(r, delays[u.origin]));
    const json = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
    if (SUGGEST.test(u.pathname) && products[u.origin]) {
      return json({ resources: { results: { products: products[u.origin].map((title, i) => ({ title, handle: `p${i}`, url: `/products/p${i}` })) } } });
    }
    if (u.pathname === "/meta.json" && names[u.origin]) return json({ name: names[u.origin] });
    return { ok: false, status: 404, text: async () => "" };
  };
}

const NOL = "https://www.nolcollective.com";

test("the common case stays fast: the confident guess answers and nothing waits", async () => {
  const t0 = Date.now();
  const hits = await storeSearchSource(Q2, {
    fetchImpl: network({ products: { [NOL]: ["Saria midi skirt (scarlet linen)"] } }),
    timeoutMs: 300, guessBudgetMs: 3_000, guessGraceMs: 2_000,
  });
  assert.equal(hits.length, 1);
  assert.ok(Date.now() - t0 < 500, `took ${Date.now() - t0}ms`);
});

test("a brand at the end is found even while the opening-word guesses hang", async () => {
  const hang = guessesWithRemainder("Saria silk midi Nol Collective")
    .filter((g) => g.basis === "prefix").flatMap((g) => g.origins);
  const t0 = Date.now();
  const hits = await storeSearchSource("Saria silk midi Nol Collective", {
    fetchImpl: network({ products: { [NOL]: ["Saria midi skirt (scarlet linen)"] }, names: { [NOL]: "Nol Collective" }, hang }),
    timeoutMs: 300, guessBudgetMs: 3_000, guessGraceMs: 150,
  });
  assert.equal(hits.length, 1);
  assert.ok(Date.now() - t0 < 1_500, `a hanging guess held the answer for ${Date.now() - t0}ms`);
});

test("a MORE confident guess wins even when a less confident one answers first", async () => {
  const COL = "https://www.collective.com";
  const hits = await storeSearchSource(Q1, {
    fetchImpl: network({
      products: { [NOL]: ["Saria midi skirt (scarlet linen)"], [COL]: ["Someone else's dress"] },
      names: { [NOL]: "Nol Collective", [COL]: "Collective" },
      delays: { [NOL]: 120 },
    }),
    timeoutMs: 1_000, guessBudgetMs: 3_000, guessGraceMs: 800,
  });
  assert.equal(hits[0].hint, "Saria midi skirt (scarlet linen)");
});

test("a closing-word guess is not trusted unless the shop's own name is the brand", async () => {
  // "…croissant bag black" guesses black.com last. A real store there selling
  // something else must not answer for Lemaire.
  const BLACK = "https://www.black.com";
  const hits = await storeSearchSource("lemaire croissant bag black", {
    fetchImpl: network({ products: { [BLACK]: ["An unrelated black tee"] }, names: { [BLACK]: "Black Tee Co" } }),
    timeoutMs: 300, guessBudgetMs: 2_000, guessGraceMs: 100,
  });
  assert.deepEqual(hits, []);
});

test("when nothing answers, the budget ends it", async () => {
  const hang = guessesWithRemainder(Q1).flatMap((g) => g.origins);
  const t0 = Date.now();
  const hits = await storeSearchSource(Q1, { fetchImpl: network({ hang }), timeoutMs: 500, guessBudgetMs: 400 });
  assert.deepEqual(hits, []);
  assert.ok(Date.now() - t0 < 1_000, `took ${Date.now() - t0}ms`);
});

// ── relevance ranks before stock ─────────────────────────────────────────────
// Availability-first was built for ONE product at several shops. One shop's
// search returns DIFFERENT products, and ranking those by stock threw away the
// shop's own relevance: Mutimer put "Funnel Neck Blouson" first, it was sold
// out, and two in-stock jackets pushed it out of a list of three.

const STOCK = { in: "in_stock", out: "out_of_stock" };
const cand = (hint, available, price = 100, currency = "AUD", url = `https://shop.test/${encodeURIComponent(hint)}`) => ({
  url, hint,
  reading: { ok: true, price, currency, available, variants: [{ label: "M", available, state: available ? STOCK.in : STOCK.out }] },
});

test("the product you named outranks in-stock strangers from the same shop", async () => {
  const { rankCandidates } = await import("../supabase/functions/_shared/search.mjs");
  const ranked = rankCandidates([
    cand("Funnel Neck Blouson", false, 416),
    cand("Flight Jacket", true, 355),
    cand("Mad. Avenue Coat", true, 536),
    cand("Farm Flannel", false, 157),
  ], { query: "Mutimer Funnel Neck Blouson in Size XS", country: "SG" });
  assert.equal(ranked[0].hint, "Funnel Neck Blouson");
});

test("a partial match doesn't lead the product you named, even when it's cheaper", async () => {
  const { rankCandidates } = await import("../supabase/functions/_shared/search.mjs");
  const ranked = rankCandidates([
    cand("Talia silk top (dusty rose silk)", true, 94.8, "USD"),
    cand("Saria midi skirt (natural linen)", true, 117.6, "USD"),
    cand("Saria midi skirt (scarlet linen)", true, 117.6, "USD"),
  ], { query: "Saria silk midi from Nol Collective, size S" });
  assert.match(ranked[0].hint, /^Saria/);
  assert.match(ranked[1].hint, /^Saria/);
});

test("the same bag at two shops: stock still decides, whatever the titles repeat", async () => {
  // One word apart only because Farfetch repeats the brand. That must not bury
  // the copy you can actually buy.
  const { rankCandidates } = await import("../supabase/functions/_shared/search.mjs");
  const ranked = rankCandidates([
    cand("LEMAIRE Small Croissant Bag In Leather", false, 1145, "USD", "https://www.farfetch.com/item-1.aspx"),
    cand("Small Croissant Bag", true, 1090, "EUR", "https://www.lemaire.fr/products/small-croissant-bag"),
  ], { query: "Lemaire Small Croissant Bag in Black" });
  assert.equal(ranked[0].url, "https://www.lemaire.fr/products/small-croissant-bag");
});

test("a colour you named breaks the tie between otherwise identical products", async () => {
  const { rankCandidates } = await import("../supabase/functions/_shared/search.mjs");
  const ranked = rankCandidates([
    cand("Saria midi skirt (natural linen)", true, 117.6, "USD"),
    cand("Saria midi skirt (scarlet linen)", true, 117.6, "USD"),
  ], { query: "saria midi skirt in scarlet" });
  assert.equal(ranked[0].hint, "Saria midi skirt (scarlet linen)");
});

test("without a query, ranking is exactly what it was", async () => {
  const { rankCandidates } = await import("../supabase/functions/_shared/search.mjs");
  const ranked = rankCandidates([cand("A", false, 100, "USD"), cand("B", true, 900, "GBP")]);
  assert.equal(ranked[0].hint, "B");
});

// ── a host that never answers ────────────────────────────────────────────────

test("a host that gives no answer at all isn't asked three more times", async () => {
  const { searchStore } = await import("../supabase/functions/_shared/search.mjs");
  let calls = 0;
  const hits = await searchStore("https://www.bmagazine.com", "new balance", {
    fetchImpl: async () => { calls++; throw new TypeError("fetch failed"); },
  });
  assert.deepEqual(hits, []);
  assert.equal(calls, 1, "one unanswered request is the answer");
});

test("a 404 on Shopify's route is an ANSWER, so WooCommerce is still asked", async () => {
  const { searchStore } = await import("../supabase/functions/_shared/search.mjs");
  const hits = await searchStore("https://goshopia.com", "scarlett dress", {
    fetchImpl: async (u) => String(u).includes("wc/store/v1/products")
      ? { ok: true, status: 200, text: async () => JSON.stringify([{ id: 1, permalink: "https://goshopia.com/p/dress", name: "Scarlett White Dress" }]) }
      : { ok: false, status: 404, text: async () => "" },
  });
  assert.equal(hits[0]?.hint, "Scarlett White Dress");
});
