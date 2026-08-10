import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMoney } from "../supabase/functions/_shared/money.mjs";

// THE BUG: vetsak.com (German Shopify) publishes 4386 EUR as "4.386". Number()
// reads that as 4.386, so our correct reading of 4386 "disagreed" with the page
// by three orders of magnitude, the price was marked untrusted, and a genuine
// 774-euro drop was filtered out and never sent.
test("a German thousands separator is not a decimal point", () => {
  assert.equal(parseMoney("4.386"), 4386);
  assert.equal(parseMoney("1.234.567"), 1234567);
  assert.equal(parseMoney("5.160"), 5160);
});

test("...but a real decimal point still is one", () => {
  assert.equal(parseMoney("4.38"), 4.38);
  assert.equal(parseMoney("0.99"), 0.99);
  assert.equal(parseMoney("4386.00"), 4386);
  assert.equal(parseMoney("17.80"), 17.8);
});

test("both separators: whichever is last is the decimal", () => {
  assert.equal(parseMoney("1.234,56"), 1234.56, "German");
  assert.equal(parseMoney("1,234.56"), 1234.56, "English");
  assert.equal(parseMoney("1.234.567,89"), 1234567.89);
});

test("a lone comma is read the same way", () => {
  assert.equal(parseMoney("1,234"), 1234, "grouping");
  assert.equal(parseMoney("4,38"), 4.38, "European decimal comma");
});

test("symbols, codes and non-breaking spaces are stripped", () => {
  assert.equal(parseMoney("€ 4.386"), 4386);
  assert.equal(parseMoney("EUR 4.386"), 4386);
  assert.equal(parseMoney("S$839"), 839);
  assert.equal(parseMoney(" 4.386 €"), 4386);
});

test("numbers pass through, and nonsense yields undefined — never NaN", () => {
  assert.equal(parseMoney(4386), 4386);
  assert.equal(parseMoney(undefined), undefined);
  assert.equal(parseMoney(null), undefined);
  assert.equal(parseMoney(""), undefined);
  assert.equal(parseMoney("Price on request"), undefined);
  assert.equal(parseMoney(NaN), undefined, "callers use == null, so NaN must never escape");
});
