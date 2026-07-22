import { test } from "node:test";
import assert from "node:assert/strict";
import { planAdd, MAX_DEFENDED, FREE_INTERVAL_MIN, DEFENDED_INTERVAL_MIN, nextCheckDelayMinutes, BASELINE_RETRY_MIN } from "../supabase/functions/_shared/policy.mjs";

const detect = (adapter, strategy) => async () => ({ adapter, strategy });

// Retry scheduling after a failed check — the bug: an Amazon book soft-failed
// on its FIRST check and exponential backoff pushed the baseline 12 hours out.
test("a never-baselined item retries soon, it does NOT back off", () => {
  // 6h Amazon item, one failure, no baseline yet → 30 min, not 720.
  assert.equal(nextCheckDelayMinutes(360, 1, false), BASELINE_RETRY_MIN);
  // Still capped by the item's own interval if that's somehow shorter.
  assert.equal(nextCheckDelayMinutes(20, 1, false), 20);
  // It doesn't matter how many times it has blipped — no baseline means keep trying.
  assert.equal(nextCheckDelayMinutes(360, 4, false), BASELINE_RETRY_MIN);
});

test("an established item that broke DOES back off exponentially, capped at 8x", () => {
  assert.equal(nextCheckDelayMinutes(360, 1, true), 720);   // 2x
  assert.equal(nextCheckDelayMinutes(360, 2, true), 1440);  // 4x
  assert.equal(nextCheckDelayMinutes(360, 3, true), 2880);  // 8x
  assert.equal(nextCheckDelayMinutes(360, 9, true), 2880);  // still 8x, not 512x
});

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
