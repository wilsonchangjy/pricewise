import { test } from "node:test";
import assert from "node:assert/strict";
import { PROVIDERS, normalizeProvider, detectProvider, buildRequestUrl, providerSummary } from "../supabase/functions/_shared/providers.mjs";

test("provider names are forgiving", () => {
  assert.equal(normalizeProvider("ScrapingBee"), "scrapingbee");
  assert.equal(normalizeProvider("scraping-bee"), "scrapingbee");
  assert.equal(normalizeProvider("Scrape.do"), "scrapedo");
  assert.equal(normalizeProvider("ScraperAPI"), "scraperapi");
  assert.equal(normalizeProvider("nonsense"), null);
});

test("an unambiguous key shape is detected", () => {
  // A realistic ScrapingBee key: long, and containing letters outside hex.
  assert.equal(detectProvider("9XZQK2WMTV8RJHYP4NBLDCF6SGA3EU7I5OQZXKMWTVJRHYPNBLDCF6SGA3EU7I5OQZXKMWTVJR"), "scrapingbee");
});

// ScraperAPI and Scrape.do keys are both 32-char hex — guessing would send every
// request to the wrong vendor and look exactly like a blocked site.
test("an AMBIGUOUS key returns null so the bot asks instead of guessing", () => {
  assert.equal(detectProvider("a1b2c3d4e5f60718293a4b5c6d7e8f90"), null);
  assert.equal(detectProvider(""), null);
});

test("each provider builds a URL with its own parameter names", () => {
  const target = "https://shop.test/p?size=M";
  const tierBy = (id, mode) => PROVIDERS[id].tiers.find((t) => t.mode === mode).params;
  const bee = buildRequestUrl("scrapingbee", target, { apiKey: "K", country: "sg", tier: tierBy("scrapingbee", "render") });
  assert.match(bee, /app\.scrapingbee\.com/);
  assert.match(bee, /api_key=K/);
  assert.match(bee, /render_js=true/);
  assert.match(bee, /country_code=sg/);

  const sapi = buildRequestUrl("scraperapi", target, { apiKey: "K", country: "sg", tier: tierBy("scraperapi", "premium") });
  assert.match(sapi, /api\.scraperapi\.com/);
  assert.match(sapi, /premium=true/);

  const sdo = buildRequestUrl("scrapedo", target, { apiKey: "K", country: "sg", tier: tierBy("scrapedo", "render") });
  assert.match(sdo, /api\.scrape\.do/);
  assert.match(sdo, /token=K/);
  assert.match(sdo, /geoCode=sg/);
});

test("the target URL survives encoding intact", () => {
  const target = "https://shop.test/p?size=M&colour=navy";
  const built = buildRequestUrl("scrapingbee", target, { apiKey: "K", tier: {} });
  assert.ok(decodeURIComponent(new URL(built).searchParams.get("url")) === target);
});

test("a tier that sets the geo param itself wins over the default country", () => {
  const built = buildRequestUrl("scrapedo", "https://x.test", { apiKey: "K", country: "us", tier: { geoCode: "sg" } });
  assert.match(built, /geoCode=sg/);
  assert.doesNotMatch(built, /geoCode=us/);
});

test("an unknown provider throws rather than building a bad request", () => {
  assert.throws(() => buildRequestUrl("nope", "https://x.test", { apiKey: "K" }), /unknown unblocker provider/);
});

test("only ScrapingBee is marked verified — the others are documented, not tested", () => {
  const s = providerSummary();
  assert.equal(s.find((p) => p.id === "scrapingbee").verified, true);
  assert.equal(s.find((p) => p.id === "scraperapi").verified, false);
  assert.ok(s.every((p) => p.freeNote && p.signup));
});

// ── measured against Scrape.do on 2026-07-21 ────────────────────────────────
// bershka/stradivarius/asos: plain = 1 credit · massimo dutti: render = 5 · zara: super = 10
test("every ladder opens on the cheapest tier — measurement, not assumption", () => {
  for (const [id, p] of Object.entries(PROVIDERS)) {
    assert.equal(p.tiers[0].mode, "plain", id);
    assert.deepEqual(p.tiers[0].params, {}, `${id} plain tier must add no paid options`);
    assert.deepEqual(p.apiTiers[0], {}, `${id} API path must try plain first`);
  }
});

test("a real 43-char Scrape.do token is accepted, not rejected as malformed", () => {
  const token = "a".repeat(43);
  assert.ok(PROVIDERS.scrapedo.keyPattern.test(token));
  assert.ok(!PROVIDERS.scrapingbee.keyPattern.test(token), "and isn't mistaken for ScrapingBee");
});

test("an 80-char ScrapingBee key still detects unambiguously", () => {
  const key = "9XZQK2WMTV8RJHYP4NBLDCF6SGA3EU7I5OQZXKMWTVJRHYPNBLDCF6SGA3EU7I5OQZXKMWTVJR";
  assert.equal(detectProvider(key), "scrapingbee");
});
