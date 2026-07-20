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
  const bee = buildRequestUrl("scrapingbee", target, { apiKey: "K", country: "sg", tier: PROVIDERS.scrapingbee.tiers[0].params });
  assert.match(bee, /app\.scrapingbee\.com/);
  assert.match(bee, /api_key=K/);
  assert.match(bee, /render_js=true/);
  assert.match(bee, /country_code=sg/);

  const sapi = buildRequestUrl("scraperapi", target, { apiKey: "K", country: "sg", tier: PROVIDERS.scraperapi.tiers[1].params });
  assert.match(sapi, /api\.scraperapi\.com/);
  assert.match(sapi, /premium=true/);

  const sdo = buildRequestUrl("scrapedo", target, { apiKey: "K", country: "sg", tier: PROVIDERS.scrapedo.tiers[0].params });
  assert.match(sdo, /api\.scrape\.do/);
  assert.match(sdo, /token=K/);
  assert.match(sdo, /geoCode=sg/);
});

test("the target URL survives encoding intact", () => {
  const target = "https://shop.test/p?size=M&colour=navy";
  const built = buildRequestUrl("scrapingbee", target, { apiKey: "K", tier: {} });
  assert.ok(decodeURIComponent(new URL(built).searchParams.get("url")) === target);
});

test("a tier that pins its own geo isn't overwritten", () => {
  const built = buildRequestUrl("scrapedo", "https://x.test", { apiKey: "K", country: "us", tier: PROVIDERS.scrapedo.tiers[2].params });
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
