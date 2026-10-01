import { test } from "node:test";
import assert from "node:assert/strict";
import { withRateLimitFallback } from "../supabase/functions/_shared/unblocker.mjs";
import { readShopify } from "../supabase/functions/_shared/adapters/shopify.mjs";

// LIVE, 2026-09-29 onward: Shopify's edge answered every request from
// Supabase's shared outbound address with 429 "local_rate_limited" — while the
// same URLs returned 200 from an ordinary connection in the same minute. All
// five tracked Shopify items failed every check, and /add and the free search
// were hit by the same wall.

const PRODUCT = JSON.stringify({
  title: "Funnel Neck Blouson", price: 40800,
  variants: [{ id: 1, title: "S", available: false, price: 40800 }, { id: 2, title: "M", available: true, price: 40800 }],
});

const res = (status, body = "") => ({ ok: status >= 200 && status < 300, status, url: "x", headers: new Headers(), text: async () => body });

/** A network where shop hosts answer `shopStatus`, and Scrape.do answers 200 with the real body. */
function network({ shopStatus, unblockerStatus = 200, body = PRODUCT }) {
  const calls = { shop: 0, unblocker: 0 };
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.startsWith("https://api.scrape.do/")) {
      calls.unblocker++;
      return { ok: unblockerStatus === 200, status: unblockerStatus, headers: new Headers({ "scrape.do-request-cost": "1", "scrape.do-remaining-credits": "776" }), text: async () => body };
    }
    calls.shop++;
    return res(shopStatus, shopStatus === 429 ? "local_rate_limited" : body);
  };
  return { fetchImpl, calls };
}

async function withGlobalFetch(fetchImpl, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try { return await fn(); } finally { globalThis.fetch = real; }
}

const KEY = { apiKey: "k".repeat(43), provider: "scrapedo" };

// ── the shared fetch wrapper (/add's probe, the free search) ─────────────────

test("a 200 passes straight through, and the key is never even looked up", async () => {
  const { fetchImpl } = network({ shopStatus: 200 });
  let lookups = 0;
  const f = withRateLimitFallback(fetchImpl, async () => { lookups++; return KEY; });
  const r = await f("https://mutimer.co/products/x.js");
  assert.equal(r.status, 200);
  assert.equal(lookups, 0);
});

test("a 429 is retried through the unblocker and answered", async () => {
  const net = network({ shopStatus: 429 });
  await withGlobalFetch(net.fetchImpl, async () => {
    const f = withRateLimitFallback(net.fetchImpl, async () => KEY);
    const r = await f("https://mutimer.co/products/x.js");
    assert.equal(r.status, 200);
    assert.equal(r.viaUnblocker, true);
    assert.equal(JSON.parse(await r.text()).title, "Funnel Neck Blouson");
    assert.equal(net.calls.unblocker, 1, "one plain-tier request, one credit");
  });
});

test("a 404 or a dead domain is an ANSWER — never paid for twice", async () => {
  const net = network({ shopStatus: 404 });
  let lookups = 0;
  const f = withRateLimitFallback(net.fetchImpl, async () => { lookups++; return KEY; });
  assert.equal((await f("https://nope.com/search/suggest.json")).status, 404);
  assert.equal(lookups, 0);
  assert.equal(net.calls.unblocker, 0);
});

test("without a key, the 429 comes back as it was", async () => {
  const net = network({ shopStatus: 429 });
  const f = withRateLimitFallback(net.fetchImpl, async () => null);
  assert.equal((await f("https://mutimer.co/products/x.js")).status, 429);
});

test("the key is looked up once per wrapper, however many 429s", async () => {
  const net = network({ shopStatus: 429 });
  let lookups = 0;
  await withGlobalFetch(net.fetchImpl, async () => {
    const f = withRateLimitFallback(net.fetchImpl, async () => { lookups++; return KEY; });
    await Promise.all([f("https://a.com/products/x.js"), f("https://b.com/products/y.js"), f("https://c.com/products/z.js")]);
  });
  assert.equal(lookups, 1);
});

// ── the checker's Shopify read ───────────────────────────────────────────────

const ITEM = { id: "17", label: "Funnel Neck Blouson", url: "https://mutimer.co/products/funnel-neck-blouson", market: "SG", currency: "SGD", variantSelector: {} };

test("a throttled Shopify read detours once and comes back marked as such", async () => {
  const net = network({ shopStatus: 429 });
  const r = await withGlobalFetch(net.fetchImpl, () => readShopify(ITEM, { getUnblocker: async () => KEY }));
  assert.equal(r.ok, true);
  assert.equal(r.price, 408);
  assert.equal(r.currency, "SGD");
  assert.equal(r.via, "unblocker");
  assert.equal(r.tier, undefined, "a detour must not be learned as the shop's tier — that rewrites the interval for good");
});

test("the detour asks for the item's own market", async () => {
  const net = network({ shopStatus: 429 });
  const seen = [];
  const spy = async (u, i) => { seen.push(String(u)); return net.fetchImpl(u, i); };
  await withGlobalFetch(spy, () => readShopify(ITEM, { getUnblocker: async () => KEY }));
  const viaUrl = new URL(seen.find((u) => u.startsWith("https://api.scrape.do/")));
  assert.match(viaUrl.searchParams.get("url"), /country=SG/);
  assert.equal(viaUrl.searchParams.get("geoCode"), "sg");
});

test("throttled with no key is RATE LIMITED — not a broken item", async () => {
  const net = network({ shopStatus: 429 });
  const r = await withGlobalFetch(net.fetchImpl, () => readShopify(ITEM, { getUnblocker: async () => null }));
  assert.equal(r.ok, false);
  assert.equal(r.kind, "rate_limited");
  assert.match(r.message, /rate-limiting my server/);
  assert.ok(!/\.js fetch failed/.test(r.message), "no more 'shopify .js fetch failed (429)' in someone's chat");
});

test("an unthrottled read never touches the key", async () => {
  const net = network({ shopStatus: 200 });
  let lookups = 0;
  const r = await withGlobalFetch(net.fetchImpl, () => readShopify(ITEM, { getUnblocker: async () => { lookups++; return KEY; } }));
  assert.equal(r.ok, true);
  assert.equal(r.via, undefined);
  assert.equal(lookups, 0);
});
