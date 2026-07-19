import { test } from "node:test";
import assert from "node:assert/strict";
import { detectAdapter, strategyFor } from "../src/router.mjs";

// Network-free: inject a fake fetch so tests are deterministic in CI.
const fakeFetch = (shopifyHosts = []) => async (url) => {
  const u = new URL(url);
  if (u.pathname.endsWith(".js") && shopifyHosts.includes(u.hostname)) {
    return { ok: true, status: 200, text: async () => JSON.stringify({ title: "X", variants: [{ id: 1, available: true }] }) };
  }
  return { ok: false, status: 404, text: async () => "" };
};

test("known brands route by host with no network", async () => {
  for (const [url, adapter] of [
    ["https://www.uniqlo.com/sg/en/products/E1/00", "uniqlo"],
    ["https://www.zara.com/sg/en/x-p1.html", "zara"],
    ["https://www.massimodutti.com/sg/x-l1", "inditex"],
    ["https://www.oysho.com/sg/x-l1", "inditex"],
    ["https://www.asos.com/x/prd/1", "asos"],
    ["https://shop.mango.com/sg/en/p/x/1/1/00", "mango"],
  ]) {
    const r = await detectAdapter(url, { fetchImpl: fakeFetch() });
    assert.equal(r.adapter, adapter, url);
  }
});

test("itxrest brands surface a productId hint from the URL", async () => {
  const b = await detectAdapter("https://www.bershka.com/sg/x-c0p235801198.html", { fetchImpl: fakeFetch() });
  assert.equal(b.adapter, "bershka");
  assert.equal(b.hints.productId, "235801198");
});

test("Wix detected by /product-page/ pattern", async () => {
  const r = await detectAdapter("https://www.munimunistudio.com/product-page/tokong", { fetchImpl: fakeFetch() });
  assert.equal(r.adapter, "wix");
});

test("unknown indie host is Shopify iff /products/{handle}.js returns variants", async () => {
  const url = "https://anane.co/collections/x/products/y";
  const yes = await detectAdapter(url, { fetchImpl: fakeFetch(["anane.co"]) });
  assert.equal(yes.adapter, "shopify");
  const no = await detectAdapter(url, { fetchImpl: fakeFetch([]) }); // .js 404s
  assert.equal(no.adapter, null);
});

test("defended adapters map to the unblocker strategy, free ones to direct", () => {
  assert.equal(strategyFor("inditex"), "unblocker");
  assert.equal(strategyFor("asos"), "unblocker");
  assert.equal(strategyFor("shopify"), "direct");
  assert.equal(strategyFor("wix"), "direct");
});

test("a non-URL is rejected cleanly", async () => {
  const r = await detectAdapter("not a url", { fetchImpl: fakeFetch() });
  assert.equal(r.adapter, null);
  assert.equal(r.via, "invalid-url");
});
