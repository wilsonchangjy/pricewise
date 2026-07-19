import { test } from "node:test";
import assert from "node:assert/strict";
import { planAdd, MAX_DEFENDED, FREE_INTERVAL_MIN, DEFENDED_INTERVAL_MIN } from "../supabase/functions/_shared/policy.mjs";

const detect = (adapter, strategy) => async () => ({ adapter, strategy });

test("free adapter → tracked immediately at the normal cadence", async () => {
  const r = await planAdd("https://anane.co/products/x", { detectAdapter: detect("shopify", "direct"), userHasKey: false, userDefendedCount: 0 });
  assert.equal(r.action, "track");
  assert.equal(r.strategy, "direct");
  assert.equal(r.intervalMinutes, FREE_INTERVAL_MIN);
});

test("generic JSON-LD fallback is still free/tracked (product-level note)", async () => {
  const r = await planAdd("https://someboutique.com/p/x", { detectAdapter: detect("jsonld", "direct"), userHasKey: false, userDefendedCount: 0 });
  assert.equal(r.action, "track");
  assert.match(r.message, /basic|product-level/i);
});

test("defended without a key → asks for /setkey", async () => {
  const r = await planAdd("https://www.zara.com/x", { detectAdapter: detect("zara", "unblocker"), userHasKey: false, userDefendedCount: 0 });
  assert.equal(r.action, "need_key");
  assert.match(r.message, /setkey/i);
});

test("defended with a key, under cap → tracked DAILY", async () => {
  const r = await planAdd("https://www.zara.com/x", { detectAdapter: detect("zara", "unblocker"), userHasKey: true, userDefendedCount: 2 });
  assert.equal(r.action, "track");
  assert.equal(r.strategy, "unblocker");
  assert.equal(r.intervalMinutes, DEFENDED_INTERVAL_MIN);
});

test(`defended at the ${MAX_DEFENDED}-item cap → refused`, async () => {
  const r = await planAdd("https://www.zara.com/x", { detectAdapter: detect("zara", "unblocker"), userHasKey: true, userDefendedCount: MAX_DEFENDED });
  assert.equal(r.action, "cap_reached");
});

test("unsupported site → friendly no + logs the request", async () => {
  const r = await planAdd("https://randomshop.example/p/1", { detectAdapter: detect(null), userHasKey: false, userDefendedCount: 0 });
  assert.equal(r.action, "unsupported");
  assert.equal(r.logRequest, true);
});
