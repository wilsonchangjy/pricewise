// FETCH-GATE CONTRACT.
//
// `validate` decides whether a DIRECT response is trusted or whether we escalate
// up the unblocker ladder. If it asserts less than the parser needs, a degraded
// page is accepted, the ladder is never reached, and the read either soft-fails
// forever or — worse — reports a live item as sold out.
//
// This file pins the gates found wanting in the 2026-07-25 sweep. Two invariants:
//   1. a gate ACCEPTS its own real captured fixture (a false reject is worse
//      than a weak gate: it burns every tier and then fails on a good page);
//   2. a page missing what the parser needs is REJECTED, or at minimum refused
//      by the parser — never turned into a confident wrong answer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseEbay } from "../supabase/functions/_shared/adapters/ebay.mjs";
import { parseAmazon, hasAvailabilityBlock } from "../supabase/functions/_shared/adapters/amazon.mjs";
import { hasJsonLdProduct, parseJsonLd } from "../supabase/functions/_shared/adapters/jsonld.mjs";

const fx = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8");
const ITEM = { url: "https://www.ebay.com/itm/287062522407", label: "x", currency: "SGD" };

// ── the severe one: a thin page must never become a false SOLD OUT ───────────
// eBay's gate was `price OR title`. A page carrying only the title passed, price
// came back undefined, `available` collapsed to false, and the alerting machine
// fired "⛔ SOLD OUT" on a live listing. Verified end-to-end before the fix.
test("ebay: a page whose price block is missing is refused, not called sold out", () => {
  const thin = fx("ebay-fixed.html").replace(/x-price-primary/g, "gone");
  const r = parseEbay(thin, ITEM);
  assert.equal(r.ok, false, "must refuse rather than report availability");
  assert.equal(r.kind, "soft");
  assert.notEqual(r.available, false, "a refusal must not carry a false 'unavailable'");
});

test("amazon: stock says buyable but no price ⇒ refuse (partial page), not sold out", () => {
  const thin = fx("amazon-sg-product.html").replace(/a-price-whole/g, "gone");
  const r = parseAmazon(thin, { url: "https://www.amazon.sg/dp/B0BZJ512J2" });
  assert.equal(r.ok, false);
  assert.equal(r.kind, "soft");
});

// ...but a GENUINELY unavailable Amazon item shows no price either, and that
// must still read cleanly. This is why the gate can't simply demand a price.
test("amazon: a genuinely unavailable item still parses (state says out of stock)", () => {
  const r = parseAmazon(fx("amazon-sg-unavailable.html"), { url: "https://www.amazon.sg/dp/B0BDHWDR12" });
  assert.equal(r.ok, true);
  assert.equal(r.available, false);
  assert.equal(r.price, undefined);
});

// ── gates accept their own real pages ────────────────────────────────────────
test("every tightened gate still accepts its real captured fixture", () => {
  assert.equal(hasAvailabilityBlock(fx("amazon-sg-product.html")), true, "amazon");
  assert.equal(hasJsonLdProduct(fx("zara-productgroup.html")), true, "zara");
  assert.equal(hasJsonLdProduct(fx("farfetch-productgroup.html")), true, "farfetch");
  assert.equal(hasJsonLdProduct(fx("mrporter-productgroup.html")), true, "mrporter");
  assert.match(fx("ebay-fixed.html"), /x-price-primary/, "ebay");
});

// ── the shared JSON-LD gate rejects what the parser can't use ────────────────
// Zara's old gate was `html.includes("application/ld+json")` — ANY JSON-LD
// passed, so breadcrumb-only category pages and challenge shells sailed through.
test("the JSON-LD gate rejects breadcrumb-only and offer-less pages", () => {
  const good = fx("zara-productgroup.html");
  assert.equal(hasJsonLdProduct(good), true);

  const breadcrumbsOnly = good.replace(/"@type"\s*:\s*"(ProductGroup|Product)"/g, '"@type":"BreadcrumbList"');
  assert.equal(hasJsonLdProduct(breadcrumbsOnly), false, "a page with only breadcrumb JSON-LD must escalate");
  assert.equal(parseJsonLd(breadcrumbsOnly, ITEM).ok, false, "...and the parser agrees it's unusable");

  const noOffers = good.replace(/"offers"/g, '"x_offers"');
  assert.equal(hasJsonLdProduct(noOffers), false, "the parser refuses without offers, so the gate must too");

  // The bare marker on an otherwise empty page is not a product page.
  assert.equal(hasJsonLdProduct('<script type="application/ld+json">{"@type":"Organization"}</script>'), false);
});
