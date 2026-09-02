import { test } from "node:test";
import assert from "node:assert/strict";

// ── a shop that has no market where you are serves its own, silently ────────
// THE DANGEROUS CASE, found by probing mutimer.co across markets we accept:
//   ?country=SG -> 417.00 SGD   (a real market)
//   ?country=KR -> 447000 KRW   (a real market)
//   ?country=IN -> 380.00 AUD   (NO market — the AU price, unchanged)
//   ?country=NO -> 345.45 AUD   (NO market — a converted display price)
// currencyForCountry() would have labelled those last two INR and NOK. "INR 380"
// for a jacket costing 380 AUD is wrong by about 25x. /meta.json can't help
// (it returns the base currency whatever ?country= says) and ships_to_countries
// can't either (Norway ships and is still priced in AUD). Ask the page.
import { probeMarketCurrency } from "../supabase/functions/_shared/adapters/shopify.mjs";

const withPage = async (currency, fn) => {
  const real = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (u) => {
    seen.push(String(u));
    return { ok: true, status: 200, url: String(u), headers: new Headers(),
             text: async () => `<script type="application/ld+json">{"@type":"Product","offers":{"priceCurrency":"${currency}","price":"1"}}</script>` };
  };
  try { return await fn(seen); } finally { globalThis.fetch = real; }
};

test("a market the shop really has is honoured, and we keep its currency", async () => {
  const out = await withPage("SGD", (seen) =>
    probeMarketCurrency("https://mutimer.co/products/x", "SG").then((r) => { 
      assert.match(seen[0], /country=SG/); return r; }));
  assert.deepEqual(out, { currency: "SGD", honoured: true });
});

test("a market the shop does NOT have is caught, so we never label AUD as INR", async () => {
  const out = await withPage("AUD", () => probeMarketCurrency("https://mutimer.co/products/x", "IN"));
  assert.equal(out.currency, "AUD", "store what the shop actually quotes");
  assert.equal(out.honoured, false, "and know it isn't the market we asked for");
});

test("an unreachable shop is UNKNOWN — we never guess a currency from silence", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 503, url: "x", headers: new Headers(), text: async () => "" });
  try {
    assert.deepEqual(await probeMarketCurrency("https://mutimer.co/products/x", "SG"), {});
  } finally { globalThis.fetch = real; }
});

test("no market means no probe and no fetch", async () => {
  assert.deepEqual(await probeMarketCurrency("https://mutimer.co/products/x", ""), {});
});
