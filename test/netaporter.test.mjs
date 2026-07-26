import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseJsonLd, hasJsonLdProduct } from "../supabase/functions/_shared/adapters/jsonld.mjs";
import { normalizeUrl } from "../supabase/functions/_shared/urlguard.mjs";

const FIXTURE = readFileSync(new URL("./fixtures/netaporter-productgroup.html", import.meta.url), "utf8");
const URL_ = "https://www.net-a-porter.com/en-sg/shop/product/lemaire/bags/cross-body/croissant-small-paneled-leather-shoulder-bag/1647597325983581";

// Captured live 2026-07-26. NET-A-PORTER ships a schema.org ProductGroup whose
// hasVariant entries carry their own offers, so the shared parser reads it
// unchanged — no bespoke adapter logic to keep in step.
test("the shared JSON-LD parser reads it: price, brandful title, variant", () => {
  const r = parseJsonLd(FIXTURE, { url: URL_ });
  assert.equal(r.ok, true);
  assert.equal(r.price, 1472);
  assert.equal(r.available, true);
  assert.equal(r.variants.length, 1);
  // titleOf prepends the brand, which the JSON-LD name omits.
  assert.match(r.title, /^LEMAIRE /);
  assert.match(r.title, /Croissant small paneled/);
});

// The page reads "US$1,472 / Approx. SGD 1,900". The SGD figure is display
// sugar; the charge is in USD, and the JSON-LD says so. Inferring SGD from the
// /en-sg/ locale would overstate the price by a third.
test("an /en-sg/ URL still prices in USD", () => {
  const r = parseJsonLd(FIXTURE, { url: URL_, currency: "SGD" });
  assert.equal(r.currency, "USD", "trust the declared currency, not the locale");
});

test("it passes the shared fetch gate", () => {
  assert.equal(hasJsonLdProduct(FIXTURE), true);
  assert.equal(hasJsonLdProduct("<html><body>challenge page</body></html>"), false);
});

test("tracking junk is stripped so one product is one row", () => {
  assert.equal(normalizeUrl(URL_ + "?utm_source=x&gad_source=1&cm_mmc=y"), normalizeUrl(URL_));
  assert.equal(normalizeUrl(URL_), URL_);
});
