import { test } from "node:test";
import assert from "node:assert/strict";
import { STATE, isBuyable, stateFromVisibility, stateFromUniqlo, describeState } from "../supabase/functions/_shared/stock.mjs";
import { evaluate } from "../supabase/functions/_shared/alerting.mjs";

test("Inditex vocabulary maps, including the COMING_SOON we were discarding", () => {
  assert.equal(stateFromVisibility("SHOW"), STATE.IN_STOCK);
  assert.equal(stateFromVisibility("SOLD_OUT"), STATE.OUT_OF_STOCK);
  assert.equal(stateFromVisibility("COMING_SOON"), STATE.COMING_SOON);
});

test("an unrecognised Inditex value is treated as NOT buyable", () => {
  // Being wrong toward "you can't buy it" is recoverable; the other way costs a trip.
  assert.equal(stateFromVisibility("SOME_NEW_VALUE"), STATE.OUT_OF_STOCK);
  assert.equal(stateFromVisibility(undefined), STATE.OUT_OF_STOCK);
});

test("Uniqlo statuses map, and OUT_OF_STOCK still doesn't read as STOCK", () => {
  assert.equal(stateFromUniqlo("IN_STOCK"), STATE.IN_STOCK);
  assert.equal(stateFromUniqlo("LOW_STOCK"), STATE.LOW_STOCK);
  assert.equal(stateFromUniqlo("OUT_OF_STOCK"), STATE.OUT_OF_STOCK);
  assert.equal(stateFromUniqlo("", 4), STATE.IN_STOCK);
  assert.equal(stateFromUniqlo("", 0), STATE.OUT_OF_STOCK);
});

test("buyable means buyable TODAY — coming soon is not", () => {
  assert.equal(isBuyable(STATE.IN_STOCK), true);
  assert.equal(isBuyable(STATE.LOW_STOCK), true);
  assert.equal(isBuyable(STATE.COMING_SOON), false);
  assert.equal(isBuyable(STATE.OUT_OF_STOCK), false);
  assert.equal(describeState(STATE.COMING_SOON), "coming soon");
});

// ── the alerting machine: additive, and the old paths must be untouched ─────
const item = { id: "1", label: "Shorts", url: "https://x.test/p", variantId: "M" };
const prevOos = { lastReading: { available: false, price: 50 }, lastAlertStatus: "oos", lastAlertPrice: 50 };
const reading = (state, available, price = 50) => ({
  ok: true, price, currency: "SGD", available,
  variants: [{ id: "M", label: "M", price, available, state }],
});

test("out of stock -> coming soon says COMING BACK, not sold out", () => {
  const { events, patch } = evaluate(item, prevOos, reading(STATE.COMING_SOON, false));
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "coming_soon");
  assert.match(events[0].text, /COMING BACK/);
  assert.equal(patch.lastAlertStatus, "coming");
});

test("coming soon doesn't repeat itself on the next check", () => {
  const prevComing = { lastReading: { available: false, price: 50 }, lastAlertStatus: "coming", lastAlertPrice: 50 };
  const { events } = evaluate(item, prevComing, reading(STATE.COMING_SOON, false));
  assert.equal(events.length, 0);
});

test("coming soon -> buyable still fires the restock alert", () => {
  const prevComing = { lastReading: { available: false, price: 50 }, lastAlertStatus: "coming", lastAlertPrice: 50 };
  const { events } = evaluate(item, prevComing, reading(STATE.IN_STOCK, true));
  assert.equal(events[0].kind, "restock");
});

test("the shop's own low-stock signal beats our ratio guess", () => {
  const prevIn = { lastReading: { available: true, price: 50 }, lastAlertStatus: "in_stock", lastAlertPrice: 50 };
  const { events } = evaluate(item, prevIn, reading(STATE.LOW_STOCK, true));
  assert.equal(events[0].kind, "low_stock");
  assert.match(events[0].text, /NEARLY GONE/);
});

test("plain sold-out behaviour is unchanged for adapters with no state", () => {
  const prevIn = { lastReading: { available: true, price: 50 }, lastAlertStatus: "in_stock", lastAlertPrice: 50 };
  const { events, patch } = evaluate(item, prevIn, reading(undefined, false));
  assert.equal(events[0].kind, "oos");
  assert.equal(patch.lastAlertStatus, "oos");
});

test("restock from oos is unchanged", () => {
  const { events } = evaluate(item, prevOos, reading(undefined, true));
  assert.equal(events[0].kind, "restock");
});
