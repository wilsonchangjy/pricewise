import { test } from "node:test";
import assert from "node:assert/strict";
import { localeFromUrl, currencyForCountry, isKnownCountry, MARKET_CHOICES, knownCountries }
  from "../supabase/functions/_shared/locale.mjs";

// PRECEDENCE, which is the whole point of the market layers:
//   explicit per-item pin  >  the URL's own locale  >  the account default
// The middle rung is this function. A link that names a country has already
// answered the question — the person chose that storefront by pasting it — so
// /add must not override it with an account default and then quote prices
// nobody can buy at.

test("a link that names its country answers for itself", () => {
  assert.equal(localeFromUrl("https://www.ssense.com/en-us/men/product/x/123").country, "US");
  assert.equal(localeFromUrl("https://www.endclothing.com/sg/some-shoe.html").country, "SG");
  assert.equal(localeFromUrl("https://shop.com/?countryIso=GB").country, "GB");
});

test("a path-less shop stays silent, so the account default can fill the gap", () => {
  // Shopify Markets sites carry no locale at all — same URL, different market.
  // This is exactly the case the account default exists for.
  assert.equal(localeFromUrl("https://mutimer.co/products/funnel-neck-blouson").country, undefined);
  assert.equal(localeFromUrl("https://simuero.com/products/octubre-silver-ring").country, undefined);
});

test("every offered market is one we can actually price", () => {
  // A button that pins a market we can't name a currency for would produce a
  // price with no denomination — the one thing this tracker refuses to do.
  for (const [cc, label] of MARKET_CHOICES) {
    assert.ok(currencyForCountry(cc), `${cc} has no currency`);
    assert.ok(isKnownCountry(cc), `${cc} not accepted by the typed path`);
    assert.ok(label.length > 2, `${cc} needs a readable label`);
  }
});

test("typed input is checked against the same map the buttons use", () => {
  assert.ok(isKnownCountry("gb"), "case-insensitive");
  assert.ok(!isKnownCountry("ZZ"));
  assert.ok(!isKnownCountry(""));
  assert.ok(!isKnownCountry(undefined));
});

// ── the shortlist is a shortlist, not the limit ─────────────────────────────
// Shipped with eight buttons and no mention that a code could be typed, which
// made eight look like the whole world — Wilson asked whether TR/MY/KR were
// simply unsupported. MY and KR always were; TR was not, and that was a fact
// about our map rather than about any shop.

test("the typed path reaches far beyond the eight buttons", () => {
  const all = knownCountries();
  assert.ok(all.length > 60, `only ${all.length} markets`);
  for (const cc of ["TR", "MY", "KR", "PL", "BR", "ZA", "IL", "VN", "MX", "SA"]) {
    assert.ok(isKnownCountry(cc), `${cc} should be priceable`);
  }
});

test("every button is also reachable by typing — one map behind both", () => {
  for (const [cc] of MARKET_CHOICES) assert.ok(knownCountries().includes(cc), cc);
});

test("no market is listed without a currency to print it in", () => {
  for (const cc of knownCountries()) assert.match(currencyForCountry(cc), /^[A-Z]{3}$/, cc);
});
