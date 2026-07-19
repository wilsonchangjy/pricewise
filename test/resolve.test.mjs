// Every expectation here is a value we VERIFIED live in Phase 0 (config.mjs),
// so this suite is really "can /add derive what we used to hand-write?".
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveSelector, fetchTitle } from "../supabase/functions/_shared/resolve.mjs";

test("uniqlo: product code from the path, colour+size from the query", () => {
  const r = resolveSelector(
    "https://www.uniqlo.com/sg/en/products/E485737-000/00?colorDisplayCode=69&sizeDisplayCode=032",
    "uniqlo",
  );
  assert.equal(r.ok, true);
  assert.deepEqual(r.selector, { productCode: "E485737-000", colorDisplayCode: "69", sizeDisplayCode: "032" });
});

test("uniqlo: a bare link still tracks, and says it's watching everything", () => {
  const r = resolveSelector("https://www.uniqlo.com/sg/en/products/E487957-000/00", "uniqlo");
  assert.equal(r.ok, true);
  assert.deepEqual(r.selector, { productCode: "E487957-000" });
  assert.match(r.watching, /every colour and size/);
});

test("uniqlo: a link with no product code is refused, not silently tracked", () => {
  const r = resolveSelector("https://www.uniqlo.com/sg/en/women", "uniqlo");
  assert.equal(r.ok, false);
  assert.match(r.reason, /product code/);
});

test("mango: productId + colour from the path", () => {
  const r = resolveSelector(
    "https://shop.mango.com/sg/en/p/men/shirts/linen/cotton-linen-blend-shirt-with-embroidered-details/27009215/07/00",
    "mango",
  );
  assert.equal(r.ok, true);
  assert.equal(r.selector.productId, "27009215");
  assert.equal(r.selector.color, "07");
  assert.equal(r.selector.sizeLabels[20], "S");
});

test("cos: product code + locale from the URL", () => {
  const r = resolveSelector(
    "https://www.cos.com/en-sg/men/menswear/shirts/casualshirts/product/seersucker-resort-shirt-black-1326785001",
    "cos",
  );
  assert.equal(r.ok, true);
  assert.deepEqual(r.selector, { code: "1326785001", locale: "en-sg", storeId: "250", merchantId: "100000072" });
});

test("bershka: productId from c0p{id}, store ids from the market map", () => {
  const r = resolveSelector(
    "https://www.bershka.com/sg/volcom-skater-bermuda-shorts-c0p235801198.html?colorId=428",
    "bershka",
  );
  assert.equal(r.ok, true);
  assert.deepEqual(r.selector, { storeId: "45109561", catalogId: "40259531", productId: "235801198" });
});

test("bershka: an unmapped market is refused rather than guessed", () => {
  const r = resolveSelector("https://www.bershka.com/de/hose-c0p235801198.html", "bershka");
  assert.equal(r.ok, false);
  assert.match(r.reason, /Singapore/);
});

test("stradivarius: store ids resolve, productId is flagged as needing the page", () => {
  const r = resolveSelector("https://www.stradivarius.com/ww/textured-sarouel-trousers-l04522175?colorId=001", "stradivarius");
  assert.equal(r.ok, true);
  assert.equal(r.selector.storeId, "58009550");
  assert.equal(r.needsPage, "productId");
});

test("asos: productId from /prd/", () => {
  const r = resolveSelector(
    "https://www.asos.com/calvin-klein/calvin-klein-icon-cotton-stretch-3-pack-darted-trunk-in-black-white-grey/prd/207830219",
    "asos",
  );
  assert.equal(r.ok, true);
  assert.equal(r.selector.productId, "207830219");
});

test("page-reading adapters need no selector at all", () => {
  for (const a of ["shopify", "wix", "jsonld", "zara", "inditex", "stories"]) {
    const r = resolveSelector("https://example.com/products/thing", a);
    assert.equal(r.ok, true, a);
    assert.deepEqual(r.selector, {}, a);
  }
});

test("fetchTitle prefers og:title and drops the brand tail", async () => {
  const fetchImpl = async () => ({
    ok: true,
    text: async () =>
      `<html><head><title>ignored</title>
       <meta property="og:title" content="Selvedge Regular Fit Jeans | UNIQLO SG"></head></html>`,
  });
  assert.equal(await fetchTitle("https://x.test/p", { fetchImpl }), "Selvedge Regular Fit Jeans");
});

test("fetchTitle returns null (never throws) when the page is unreachable", async () => {
  const fetchImpl = async () => { throw new Error("ETIMEDOUT"); };
  assert.equal(await fetchTitle("https://x.test/p", { fetchImpl }), null);
});
