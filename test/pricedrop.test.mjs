import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, isDropWorthAlerting } from "../supabase/functions/_shared/alerting.mjs";
import { STATE } from "../supabase/functions/_shared/stock.mjs";

// The alert that started this: EUR 65.00 -> EUR 64.00, announced as "(2% off)".
// A real drop, and useless news.
const item = { id: "1", label: "Sunset Bottom (S)", url: "https://anane.co/p", variantId: "S" };
const at = (price) => ({ lastReading: { available: true, price }, lastAlertStatus: "in_stock", lastAlertPrice: price });
const reading = (price) => ({
  ok: true, price, currency: "EUR", available: true,
  variants: [{ id: "S", label: "S", price, available: true, state: STATE.IN_STOCK }],
});
const drops = (r) => r.events.filter((e) => e.kind === "price_drop");

test("the one-euro drop that prompted this stays quiet", () => {
  const { events, patch } = evaluate(item, at(65), reading(64));
  assert.equal(drops({ events }).length, 0);
  assert.equal(patch.lastAlertPrice, undefined, "and the yardstick must NOT move");
});

test("a drop that clears both bars alerts, and reads honestly", () => {
  const { events, patch } = evaluate(item, at(65), reading(61.75)); // exactly 5%
  const [d] = drops({ events });
  assert.ok(d, "5% of 65 is 3.25, which also clears the 2-unit floor");
  assert.match(d.text, /EUR 65\.00 -> EUR 61\.75/);
  assert.equal(patch.lastAlertPrice, 61.75);
});

// THE REASON THE SUPPRESSED CASE MUST NOT BANK THE NEW PRICE. Were the yardstick
// reset on every quiet drop, each step would be "only 1 off the last one" and the
// item could bleed 65 -> 55 without ever saying a word.
test("a slow bleed still surfaces, measured from the last price we ALERTED at", () => {
  let state = at(65);
  for (const p of [64, 63, 62]) {
    const { events, patch } = evaluate(item, state, reading(p));
    assert.equal(drops({ events }).length, 0, `${p} should be quiet`);
    state = { ...state, lastReading: { available: true, price: p }, ...patch };
    assert.equal(state.lastAlertPrice, 65, "baseline held at the last alerted price");
  }
  const { events } = evaluate(item, state, reading(61.5));
  const [d] = drops({ events });
  assert.ok(d, "the cumulative fall from 65 clears the bar even though each step didn't");
  assert.match(d.text, /EUR 65\.00 -> EUR 61\.50/, "reports the real fall, not the last step");
});

// A flat 5-unit floor was the tempting simplification and would have broken this.
test("a cheap item's genuinely good deal is not muted by the absolute floor", () => {
  const [d] = drops(evaluate(item, at(15), reading(12)));
  assert.ok(d, "3.00 off 15.00 is 20% — exactly what someone tracks an item for");
});

test("pennies off a cheap item are still noise", () => {
  assert.equal(drops(evaluate(item, at(5), reading(4.5))).length, 0, "10% but only 0.50");
});

test("an expensive item needs a real cut, not a rounding change", () => {
  assert.equal(drops(evaluate(item, at(800), reading(780))).length, 0, "20 off 800 is 2.5%");
  assert.ok(drops(evaluate(item, at(800), reading(760)))[0], "40 off 800 is 5%");
});

// The user asked for this number explicitly. Their instruction outranks our floor.
test("a target price the user set ALWAYS fires, however small the step", () => {
  const withTarget = { ...item, targetPrice: 64 };
  const { events, patch } = evaluate(withTarget, at(65), reading(64));
  const [t] = events.filter((e) => e.kind === "target_hit");
  assert.ok(t, "65 -> 64 is below the drop floor, but they asked to hear at 64");
  assert.equal(patch.lastAlertPrice, 64);
});

test("stock news is not a price event and is never thresholded", () => {
  const backIn = evaluate(item, { lastReading: { available: false, price: 65 }, lastAlertStatus: "oos", lastAlertPrice: 65 }, reading(64.9));
  assert.ok(backIn.events.some((e) => e.kind === "restock"), "a restock stands on its own");
});

test("the bar is max(5%, 2) — both must clear", () => {
  assert.equal(isDropWorthAlerting(65, 64), false);      // 1.5%, 1.00
  assert.equal(isDropWorthAlerting(65, 61.75), true);    // 5.0%, 3.25
  assert.equal(isDropWorthAlerting(15, 12), true);       // 20%,  3.00
  assert.equal(isDropWorthAlerting(5, 4.5), false);      // 10%,  0.50
  assert.equal(isDropWorthAlerting(40, 38), true);       // 5.0%, 2.00 — both exactly at the bar
  assert.equal(isDropWorthAlerting(65, 70), false);      // not a drop
  assert.equal(isDropWorthAlerting(0, 0), false);        // no baseline to measure from
});
