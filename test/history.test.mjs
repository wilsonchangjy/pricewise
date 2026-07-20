import { test } from "node:test";
import assert from "node:assert/strict";
import { sparkline, contextLine, formatHistory } from "../supabase/functions/_shared/history.mjs";

const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86_400_000).toISOString();

test("sparkline maps values across the block range", () => {
  assert.equal(sparkline([1, 2, 3, 4, 5, 6, 7, 8]).length, 8);
  assert.match(sparkline([10, 20, 30]), /^[▁▂▃▄▅▆▇█]+$/u);
  assert.equal(sparkline([5, 5, 5]), "▁▁▁", "a flat price is a flat line, not noise");
  assert.equal(sparkline([]), "");
  assert.equal(sparkline([1, NaN, 3]).length, 2, "junk values are dropped, not rendered");
});

// ── the honesty gate: this is the part that must not overclaim ───────────────
test("a young item never claims a low — it says how long we've watched", () => {
  const line = contextLine({
    currency: "SGD", current_price: 99, min_price: 99, max_price: 189,
    min_at: iso(1), observations: 3, observation_days: 3, is_lowest: true,
  });
  assert.doesNotMatch(line, /lowest/i, "3 days of data cannot support a superlative");
  assert.match(line, /3 days/);
});

test("with enough history, a genuine low is stated as OUR low", () => {
  const line = contextLine({
    currency: "SGD", current_price: 99, min_price: 99, max_price: 189,
    min_at: iso(0), observations: 12, observation_days: 120, is_lowest: true,
  });
  assert.match(line, /Lowest I've seen in 90 days of watching/);
});

test("the window never exceeds how long we've actually watched", () => {
  const line = contextLine({
    currency: "SGD", current_price: 99, min_price: 99, max_price: 189,
    min_at: iso(0), observations: 5, observation_days: 30, is_lowest: true,
  });
  assert.match(line, /30 days/, "claiming a 90-day low after 30 days of watching would be a lie");
});

test("not-the-lowest gets useful context instead of silence", () => {
  const line = contextLine({
    currency: "SGD", current_price: 120, min_price: 99, max_price: 189,
    min_at: iso(10), observations: 8, observation_days: 60, is_lowest: false,
  });
  assert.match(line, /Still above its 60-day low of SGD 99\.00 \(10 days ago\)/);
});

test("a single observation says nothing at all", () => {
  assert.equal(contextLine({ observations: 1, observation_days: 40 }), "");
  assert.equal(contextLine(null), "");
});

test("/history always discloses that this is only what WE observed", () => {
  const msg = formatHistory(
    { title: "Wool Coat", url: "https://x.test/p" },
    { currency: "SGD", current_price: 129, min_price: 129, max_price: 189,
      min_at: iso(2), observations: 6, observation_days: 90, is_lowest: true },
    [{ price: 189 }, { price: 165 }, { price: 129 }],
  );
  assert.match(msg, /since I started watching, not the shop's own history/);
  assert.match(msg, /low SGD 129\.00 · high SGD 189\.00/);
  assert.match(msg, /[▁▂▃▄▅▆▇█]/u);
});

test("/history on an unread product doesn't invent a chart", () => {
  const msg = formatHistory({ title: "New Thing", url: "https://x.test/p" }, { observations: 0 }, []);
  assert.match(msg, /haven't recorded a price/);
});

test("a flat price reports 'unchanged', not a change count", () => {
  const msg = formatHistory(
    { title: "Jeans", url: "https://x.test/p" },
    { currency: "SGD", current_price: 59.9, min_price: 59.9, max_price: 59.9,
      min_at: iso(0), observations: 3, observation_days: 0, is_lowest: true },
    [{ price: 59.9 }, { price: 59.9 }, { price: 59.9 }],
  );
  assert.match(msg, /unchanged so far/);
  assert.doesNotMatch(msg, /price changes/);
});

test("real moves are counted as moves", () => {
  const msg = formatHistory(
    { title: "Coat", url: "https://x.test/p" },
    { currency: "SGD", current_price: 129, min_price: 129, max_price: 189,
      min_at: iso(1), observations: 3, observation_days: 60, is_lowest: true },
    [{ price: 189 }, { price: 165 }, { price: 129 }],
  );
  assert.match(msg, /2 price changes/);
});
