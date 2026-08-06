import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeUrl, assertSafeUrl, cleanUrl } from "../supabase/functions/_shared/urlguard.mjs";

test("campaign junk is stripped so shared links dedupe to one product", () => {
  const a = normalizeUrl("https://Brand.com/products/tee?utm_source=ig&utm_medium=story&fbclid=abc&variant=42");
  const b = normalizeUrl("https://brand.com/products/tee?variant=42&gclid=xyz&srsltid=q");
  assert.equal(a, b);
  assert.equal(a, "https://brand.com/products/tee?variant=42");
});

test("real product params survive — dropping them would change which size we watch", () => {
  const u = normalizeUrl("https://www.uniqlo.com/sg/en/products/E485737-000/00?colorDisplayCode=69&sizeDisplayCode=032&utm_campaign=sale");
  assert.match(u, /colorDisplayCode=69/);
  assert.match(u, /sizeDisplayCode=032/);
  assert.doesNotMatch(u, /utm_campaign/);
  assert.match(normalizeUrl("https://www.oysho.com/sg/jacket-l34467332?colorId=384&fbclid=z"), /colorId=384/);
});

test("query order and fragments don't create duplicate rows", () => {
  assert.equal(
    normalizeUrl("https://s.com/p?b=2&a=1#reviews"),
    normalizeUrl("https://s.com/p?a=1&b=2"),
  );
});

test("SSRF: internal and metadata addresses are refused", () => {
  for (const bad of [
    "http://169.254.169.254/latest/meta-data/",   // cloud metadata
    "http://127.0.0.1:8080/admin",
    "http://10.0.0.5/",
    "http://192.168.1.1/",
    "http://172.16.0.9/",
    "http://100.64.0.1/",
    "http://localhost/",
    "http://db.internal/",
    "http://[::1]/",
    "http://2130706433/",                          // decimal 127.0.0.1
    "http://0x7f000001/",                          // hex 127.0.0.1
  ]) {
    assert.equal(assertSafeUrl(bad).ok, false, bad);
  }
});

test("SSRF: non-web schemes, credentials and odd ports are refused", () => {
  for (const bad of [
    "file:///etc/passwd",
    "ftp://brand.com/x",
    "https://user:pass@brand.com/p",
    "https://brand.com:8443/p",
  ]) {
    assert.equal(assertSafeUrl(bad).ok, false, bad);
  }
});

test("ordinary storefront links still pass", () => {
  for (const good of [
    "https://www.zara.com/sg/en/shirt-p05344344.html",
    "https://brand.com/products/tee",
    "http://shop.example.co.uk:80/p/1",
  ]) {
    assert.equal(assertSafeUrl(good).ok, true, good);
  }
});

test("cleanUrl guards first, then normalises", () => {
  assert.equal(cleanUrl("http://127.0.0.1/p").ok, false);
  assert.equal(cleanUrl("https://brand.com/p?utm_source=x").url, "https://brand.com/p");
});

// ── redirect hops ────────────────────────────────────────────────────────────
import { safeFetch } from "../supabase/functions/_shared/fetcher.mjs";

const hop = (status, location) => ({
  status,
  ok: false,
  headers: { get: (k) => (k.toLowerCase() === "location" ? location : null) },
});
const page = () => ({ status: 200, ok: true, headers: { get: () => null }, text: async () => "<html>hi</html>" });

test("a redirect to cloud metadata is blocked, not followed", async () => {
  const fetchImpl = async (u) => (u.includes("brand.com") ? hop(302, "http://169.254.169.254/latest/meta-data/") : page());
  await assert.rejects(
    () => safeFetch("https://brand.com/p", {}, { fetchImpl }),
    /blocked redirect target/,
  );
});

test("a redirect to a private IP is blocked even after several public hops", async () => {
  const chain = {
    "https://a.test/1": hop(301, "https://b.test/2"),
    "https://b.test/2": hop(302, "https://c.test/3"),
    "https://c.test/3": hop(307, "http://10.0.0.7/admin"),
  };
  const fetchImpl = async (u) => chain[u] ?? page();
  await assert.rejects(() => safeFetch("https://a.test/1", {}, { fetchImpl }), /blocked redirect target/);
});

test("ordinary redirects still resolve, and relative Locations work", async () => {
  const chain = {
    "https://shop.test/p": hop(301, "/en/p"),
    "https://shop.test/en/p": page(),
  };
  const fetchImpl = async (u) => chain[u] ?? page();
  const res = await safeFetch("https://shop.test/p", {}, { fetchImpl });
  assert.equal(res.status, 200);
});

test("a redirect loop gives up instead of hanging", async () => {
  const fetchImpl = async () => hop(302, "https://loop.test/again");
  await assert.rejects(() => safeFetch("https://loop.test/a", {}, { fetchImpl }), /too many redirects/);
});

// Shopify's PREDICTIVE-search endpoint is the one our own describe-an-item
// search calls, and it stamps a per-search session id on every result. Left in,
// each search would mint a fresh product row for a page we may already track —
// and pay to fetch it separately, forever.
test("Shopify predictive-search ids don't split one product into many rows", () => {
  const a = normalizeUrl("https://www.everlane.com/products/mens-cashmere-crew-denim-blue?_pos=3&_psq=the+cashmere+crew&_psid=b90b869a9&_ss=e");
  const b = normalizeUrl("https://www.everlane.com/products/mens-cashmere-crew-denim-blue?_psid=deadbeef&_psq=cashmere");
  assert.equal(a, b);
  assert.equal(a, "https://www.everlane.com/products/mens-cashmere-crew-denim-blue");
  // ...and a real variant param still survives — it names the size we watch.
  assert.match(normalizeUrl("https://x.myshopify.com/products/y?variant=42&_psid=z"), /variant=42/);
});

// THG (Lookfantastic, Cult Beauty) hangs a Bazaarvoice page-state and a
// "how did you get here" context on product links — `rctxt=postAddToBasket`
// literally records that you just added it to a basket. Same row-splitting
// hazard as Shopify's _psid: one product, many tracked rows, each paid for.
test("THG context params don't split one product into many rows", () => {
  const a = normalizeUrl("https://www.lookfantastic.com/p/the-ordinary-niacinamide-10-zinc-1-serum-30ml/13187076/?bvstate=pg%3A50%2Fct%3Ar&rctxt=default");
  const b = normalizeUrl("https://www.lookfantastic.com/p/the-ordinary-niacinamide-10-zinc-1-serum-30ml/13187076/?rctxt=postAddToBasket");
  assert.equal(a, b);
  assert.match(a, /13187076/, "the id that identifies the product must survive");
});
