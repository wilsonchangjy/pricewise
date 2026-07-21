import { test } from "node:test";
import assert from "node:assert/strict";
import { TIER_COST, ADAPTER_TIER, TIER_INTERVAL_MIN, monthlyCredits } from "../supabase/functions/_shared/policy.mjs";

// These mirror what we measured against Scrape.do on 2026-07-21.
test("monthly cost matches the hand arithmetic we reasoned about", () => {
  assert.equal(monthlyCredits("super", 1440), 300);   // zara, daily
  assert.equal(monthlyCredits("render", 1440), 150);  // massimo dutti, daily
  assert.equal(monthlyCredits("plain", 1440), 30);    // bershka, daily
  assert.equal(monthlyCredits("plain", 360), 120);    // bershka, every 6h
});

test("a realistic five-item defended list fits a 1,000-credit free tier", () => {
  const list = [["plain", 360], ["plain", 360], ["render", 1440], ["render", 1440], ["super", 1440]];
  const total = list.reduce((n, [t, i]) => n + monthlyCredits(t, i), 0);
  assert.equal(total, 840);
  assert.ok(total < 1000);
});

test("five Zara items do NOT fit — the case the flat cap got wrong", () => {
  const total = 5 * monthlyCredits("super", 1440);
  assert.equal(total, 1500);
  assert.ok(total > 1000, "this is why the cap has to count credits, not items");
});

test("cheap tiers get a faster cadence than expensive ones", () => {
  assert.ok(TIER_INTERVAL_MIN.plain < TIER_INTERVAL_MIN.super);
  assert.equal(TIER_INTERVAL_MIN.plain, 360);
});

test("every defended adapter has a measured starting estimate", () => {
  for (const a of ["bershka", "stradivarius", "asos", "inditex", "stories", "zara"]) {
    assert.ok(ADAPTER_TIER[a], a);
    assert.ok(TIER_COST[ADAPTER_TIER[a]], `${a} tier must have a cost`);
  }
});

test("an unknown tier is costed conservatively, not as free", () => {
  assert.ok(monthlyCredits("who-knows", 1440) > 0);
});
