import { test } from "node:test";
import assert from "node:assert/strict";
import { comparePrices, verifyPrice } from "../supabase/functions/_shared/verify.mjs";

test("matching prices agree, including cent-level drift", () => {
  assert.equal(comparePrices({ price: 59.9, currency: "SGD" }, { price: 59.9, currency: "SGD" }).status, "agree");
  assert.equal(comparePrices({ price: 59.9, currency: "SGD" }, { price: 59.91, currency: "SGD" }).status, "agree");
  assert.equal(comparePrices({ price: 295.99 }, { price: 296.0 }).status, "agree");
});

test("a genuinely different price disagrees", () => {
  const v = comparePrices({ price: 59.9, currency: "SGD" }, { price: 129.0, currency: "SGD" });
  assert.equal(v.status, "disagree");
  assert.match(v.reason, /we read 59\.9, the page says 129/);
});

// The trap we've already hit once: geo-localized JSON-LD reporting another currency.
test("a currency mismatch is UNKNOWN, never a disagreement", () => {
  const v = comparePrices({ price: 70, currency: "USD" }, { price: 94.99, currency: "SGD" });
  assert.equal(v.status, "unknown");
  assert.match(v.reason, /currency differs/);
});

test("missing data is unknown, not disagreement", () => {
  assert.equal(comparePrices({ price: 59.9 }, {}).status, "unknown");
  assert.equal(comparePrices({}, { price: 59.9 }).status, "unknown");
  assert.equal(comparePrices(null, null).status, "unknown");
});

test("an unreachable second opinion never condemns a good reading", async () => {
  const v = await verifyPrice({ url: "https://x.test/p" }, { price: 10, currency: "SGD" }, {
    fetchImpl: async () => ({ ok: false, status: 503, body: "" }),
  });
  assert.equal(v.status, "unknown");
});

test("a page with no JSON-LD is unknown, not disagreement", async () => {
  const v = await verifyPrice({ url: "https://x.test/p" }, { price: 10 }, {
    fetchImpl: async () => ({ ok: true, status: 200, body: "<html><body>nothing</body></html>" }),
  });
  assert.equal(v.status, "unknown");
});

test("end to end: page JSON-LD contradicting the adapter is caught", async () => {
  const ld = JSON.stringify({
    "@type": "Product", name: "Jeans",
    offers: { "@type": "Offer", price: "129.00", priceCurrency: "SGD", availability: "https://schema.org/InStock" },
  });
  const v = await verifyPrice({ url: "https://x.test/p" }, { price: 59.9, currency: "SGD" }, {
    fetchImpl: async () => ({ ok: true, status: 200, body: `<script type="application/ld+json">${ld}</script>` }),
  });
  assert.equal(v.status, "disagree");
});

// ── the second opinion must come from the SAME storefront ────────────────────
// REGRESSION. verifyPrice used to fetch product.url bare. On a market-pinned
// row that is a different shop wearing the same name: the checker read
// mutimer.co at ?country=SG (SGD 418) while this fetched the plain URL from
// Supabase's datacentre IP, was geo-routed to Australia, and read AUD 380.
// comparePrices() then correctly refused to judge across currencies and
// returned "unknown" forever — verification silently switched off on exactly
// the rows most likely to need it.
import { verifyUrlFor } from "../supabase/functions/_shared/verify.mjs";

test("a market-pinned Shopify row is verified against that market", () => {
  const u = verifyUrlFor({ url: "https://mutimer.co/products/funnel-neck-blouson", market: "SG", adapter: "shopify" });
  assert.match(u, /[?&]country=SG/);
});

test("an unpinned row is fetched exactly as before", () => {
  const url = "https://mutimer.co/products/funnel-neck-blouson";
  assert.equal(verifyUrlFor({ url, adapter: "shopify" }), url);
});

test("a non-Shopify row keeps the plain URL — ?country= is Shopify's parameter, not a standard", () => {
  const url = "https://www.farfetch.com/sg/shopping/x-item-123.aspx";
  assert.equal(verifyUrlFor({ url, market: "SG", adapter: "farfetch" }), url);
});

test("a URL that already pins a country is left alone", () => {
  const url = "https://mutimer.co/products/x?country=GB";
  assert.equal(verifyUrlFor({ url, market: "SG", adapter: "shopify" }), url);
});

test("verifyPrice reads the pinned market and can now AGREE instead of shrugging", async () => {
  const seen = [];
  const page = JSON.stringify({
    "@type": "Product", name: "Funnel Neck Blouson",
    url: "https://mutimer.co/products/funnel-neck-blouson",
    offers: { "@type": "Offer", price: "418.00", priceCurrency: "SGD", availability: "https://schema.org/InStock" },
  });
  const fetchImpl = async (u) => {
    seen.push(u);
    return { ok: true, status: 200, url: u, body: `<script type="application/ld+json">${page}</script>` };
  };
  const verdict = await verifyPrice(
    { url: "https://mutimer.co/products/funnel-neck-blouson", title: "Funnel Neck Blouson", market: "SG", adapter: "shopify" },
    { price: 418, currency: "SGD" },
    { fetchImpl },
  );
  assert.match(seen[0], /country=SG/, "it asked the SG storefront");
  assert.equal(verdict.status, "agree", "which is the whole point — before this it was 'unknown' every time");
});
