import { test } from "node:test";
import assert from "node:assert/strict";
import {
  identityTokens, sameProductPage, canonicalOf, landedElsewhere,
} from "../supabase/functions/_shared/landed.mjs";

// The live failure this guards: an SSENSE /en-us/ product URL, geo-redirected to
// a brand LISTING page, read as its first tile — "OUR LEGACY Black Mini Jacket,
// USD 720" reported for a page that is Black Camion Boots at USD 760.
const SSENSE = "https://www.ssense.com/en-us/men/product/our-legacy/black-camion-boots/18122381";
const LISTING = "https://www.ssense.com/en-sg/men/designers/our-legacy";

test("identity means the product, not the country or the language", () => {
  const t = identityTokens(SSENSE);
  assert.ok(t.includes("18122381"), "the numeric id retailers key on");
  assert.ok(t.includes("black-camion-boots"), "the slug");
  // Short segments are worthless as evidence — "men" and "sg" match anything.
  assert.deepEqual(identityTokens("https://x.test/sg/men/p"), []);
});

test("a geo-swap is the SAME product and must not be refused", () => {
  // This is the common, legitimate redirect: END and Castlery both do it, and
  // it's what we WANT (local price). The slug survives, so it passes.
  assert.ok(sameProductPage(
    "https://www.endclothing.com/us/our-legacy-camion-boot-cocbb.html",
    "https://www.endclothing.com/sg/our-legacy-camion-boot-cocbb.html",
  ));
  assert.ok(sameProductPage(SSENSE, "https://www.ssense.com/en-sg/men/product/our-legacy/black-camion-boots/18122381"));
  // ...as are a dropped query string and a trailing slash.
  assert.ok(sameProductPage(SSENSE, SSENSE + "/?utm_source=x"));
});

test("a listing page is NOT the product, however plausible it looks", () => {
  assert.equal(sameProductPage(SSENSE, LISTING), false);
  assert.equal(sameProductPage(SSENSE, "https://www.ssense.com/"), false);
});

test("nothing distinctive to test on means we keep quiet, not refuse", () => {
  // A short, id-less URL gives no evidence either way. Refusing here would break
  // real tracking for the sake of a guess.
  assert.ok(sameProductPage("https://x.test/p", "https://x.test/anything-at-all"));
  assert.equal(landedElsewhere({ requestedUrl: "https://x.test/p", html: "<html></html>" }).away, false);
});

test("the canonical is read whichever order the attributes come in", () => {
  assert.equal(canonicalOf(`<link rel="canonical" href="${LISTING}">`), LISTING);
  assert.equal(canonicalOf(`<link href="${LISTING}" rel=canonical>`), LISTING);
  assert.equal(canonicalOf(`<meta property="og:url" content="${LISTING}">`), LISTING);
  assert.equal(canonicalOf("<html><head></head></html>"), undefined);
});

// The canonical — not the transport's final URL — is the load-bearing signal,
// because defended stores are fetched through an unblocker that follows
// redirects inside the proxy and hands back only HTML.
test("a page that names itself something else is caught with no final URL at all", () => {
  const off = landedElsewhere({
    requestedUrl: SSENSE,
    html: `<html><head><link rel="canonical" href="${LISTING}"></head><body>…</body></html>`,
  });
  assert.equal(off.away, true);
  assert.equal(off.landedOn, LISTING);
});

test("the transport's final URL can convict, and is never used to acquit", () => {
  // Direct fetches also tell us where they ended up — use it.
  assert.equal(landedElsewhere({ requestedUrl: SSENSE, finalUrl: LISTING }).away, true);

  // But a proxy echoing the requested URL back proves nothing about what it
  // actually fetched, so a matching finalUrl must not override a canonical that
  // says otherwise.
  const off = landedElsewhere({
    requestedUrl: SSENSE,
    finalUrl: SSENSE,
    html: `<link rel="canonical" href="${LISTING}">`,
  });
  assert.equal(off.away, true, "the page's own claim wins over the transport's");
});

test("the ordinary case: right page, canonical agrees, nothing happens", () => {
  const off = landedElsewhere({
    requestedUrl: SSENSE,
    finalUrl: SSENSE,
    html: `<link rel="canonical" href="${SSENSE}">`,
  });
  assert.equal(off.away, false);
});
