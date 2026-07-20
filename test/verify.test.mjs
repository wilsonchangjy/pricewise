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
