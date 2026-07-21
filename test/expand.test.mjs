// Share links: the blind spot Wilson found. Every store's share button hands out
// a short link, and we refused them outright — "I can't track amzn.asia yet" for
// a store we fully support.
import { test } from "node:test";
import assert from "node:assert/strict";
import { expandUrl, isShortLink } from "../supabase/functions/_shared/expand.mjs";
import { normalizeUrl } from "../supabase/functions/_shared/urlguard.mjs";

const res = (status, { location, body = "" } = {}) => ({
  status,
  headers: { get: (k) => (k.toLowerCase() === "location" ? location ?? null : null) },
  text: async () => body,
});

test("known share hosts are recognised", () => {
  assert.equal(isShortLink("https://amzn.asia/d/0c8hClao"), true);
  assert.equal(isShortLink("https://s.lazada.sg/s.5HYkw?c=c"), true);
  assert.equal(isShortLink("https://shope.ee/abc"), true);
  assert.equal(isShortLink("https://www.amazon.sg/dp/B0BZJ512J2"), false, "a normal link needs no expansion");
});

test("an HTTP redirect chain resolves (the Amazon shape)", async () => {
  const chain = {
    "https://amzn.asia/d/x": res(301, { location: "https://www.amazon.sg/dp/0393356256?ref=cm_sw" }),
    "https://www.amazon.sg/dp/0393356256?ref=cm_sw": res(200),
  };
  const r = await expandUrl("https://amzn.asia/d/x", { fetchImpl: async (u) => chain[u] ?? res(200) });
  assert.equal(r.ok, true);
  assert.equal(normalizeUrl(r.url), "https://www.amazon.sg/dp/0393356256");
});

test("a meta-refresh doorway resolves (the Lazada shape)", async () => {
  const doorway = res(200, { body: '<meta http-equiv="refresh" content="0; url=https://www.lazada.sg/products/pdp-i123-s456.html?pvid=abc">' });
  const chain = { "https://s.lazada.sg/s.x": doorway };
  const r = await expandUrl("https://s.lazada.sg/s.x", { fetchImpl: async (u) => chain[u] ?? res(200) });
  assert.equal(r.ok, true);
  assert.match(r.url, /lazada\.sg\/products\/pdp-i123/);
});

test("a meta refresh to the SAME host is ignored", async () => {
  // An ordinary page can carry a refresh tag (session timeouts, for one). Only a
  // cross-host hop is a doorway.
  const page = res(200, { body: '<meta http-equiv="refresh" content="30; url=/cart-expired">' });
  const r = await expandUrl("https://shop.test/p", { fetchImpl: async () => page });
  assert.equal(r.ok, true);
  assert.equal(r.url, "https://shop.test/p");
});

test("a shortener pointing somewhere internal is refused", async () => {
  const evil = res(302, { location: "http://169.254.169.254/latest/meta-data/" });
  const r = await expandUrl("https://bit.ly/x", { fetchImpl: async () => evil });
  assert.equal(r.ok, false);
  assert.match(r.reason, /refused/);
});

test("a redirect loop gives up", async () => {
  const r = await expandUrl("https://bit.ly/loop", { fetchImpl: async () => res(302, { location: "https://bit.ly/loop2" }) });
  assert.equal(r.ok, false);
  assert.match(r.reason, /too many/);
});

test("Lazada's ~1KB of per-share tracking collapses to one canonical URL", () => {
  const a = "https://www.lazada.sg/products/pdp-i3519845757-s24163287724.html?laz_token=ec4a91&pvid=00abc&spm=a2o42";
  const b = "https://www.lazada.sg/products/pdp-i3519845757-s24163287724.html?laz_token=DIFFERENT&pvid=other";
  assert.equal(normalizeUrl(a), normalizeUrl(b), "two shares of one product = one row");
  assert.equal(normalizeUrl(a), "https://www.lazada.sg/products/pdp-i3519845757-s24163287724.html");
});
