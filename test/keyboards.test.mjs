import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseCallback, listKeyboard, itemKeyboard, sizeKeyboard, everyKeyboard, confirmRemoveKeyboard,
  targetKeyboard, setEveryIntervalKeyboard, setEveryScopeKeyboard,
  prefsKeyboard, prefsSizeCategoryKeyboard,
} from "../supabase/functions/_shared/keyboards.mjs";

const allData = (kb) => kb.inline_keyboard.flat().map((b) => b.callback_data);
const allText = (kb) => kb.inline_keyboard.flat().map((b) => b.text);

test("callback data stays inside Telegram's 64-byte cap", () => {
  const variants = Array.from({ length: 24 }, (_, i) => ({ id: `519188937-251-${i}`, label: `EU ${36 + i}`, available: true }));
  for (const d of allData(sizeKeyboard(999999, variants))) {
    assert.ok(Buffer.byteLength(d, "utf8") <= 64, `${d} is ${Buffer.byteLength(d)} bytes`);
  }
});

test("parseCallback round-trips, including ids containing colons", () => {
  assert.deepEqual(parseCallback("i:12"), { action: "i", subId: 12, arg: undefined });
  assert.deepEqual(parseCallback("S:12:519188937-251-2"), { action: "S", subId: 12, arg: "519188937-251-2" });
  assert.deepEqual(parseCallback("E:7:12h"), { action: "E", subId: 7, arg: "12h" });
  assert.equal(parseCallback("L").subId, undefined, "a list button carries no item");
});

test("hostile callback data parses without throwing or inventing an id", () => {
  for (const junk of ["", "::::", "i:abc", "i:-1:../../etc", "💥:1"]) {
    const parsed = parseCallback(junk);
    if (parsed?.subId !== undefined) assert.ok(Number.isInteger(parsed.subId), junk);
  }
});

test("the size picker shows what the shop offers, marking stock and choice", () => {
  const variants = [
    { id: "a", label: "UK8/EU42", available: true },
    { id: "b", label: "UK9/EU43", available: false },
    { id: "c", label: "UK10/EU44", available: true },
  ];
  const kb = sizeKeyboard(5, variants, "c");
  const labels = kb.inline_keyboard.flat().map((b) => b.text);
  assert.ok(labels.some((l) => l === "UK8/EU42"), "in stock: no marker");
  assert.ok(labels.some((l) => l.startsWith("✖️")), "sold out is marked");
  assert.ok(labels.some((l) => l.startsWith("✅")), "the current choice is marked");
  assert.ok(labels.includes("Any size"), "there must be a way back to watching everything");
});

test("long size labels are truncated so buttons stay readable", () => {
  const kb = sizeKeyboard(1, [{ id: "x", label: "Extra Extra Large Tall Fit Something", available: true }]);
  assert.ok(kb.inline_keyboard[0][0].text.length <= 18);
});

test("list numbering maps to subscription ids, five per row", () => {
  const subs = Array.from({ length: 12 }, (_, i) => ({ id: 100 + i }));
  const kb = listKeyboard(subs);
  assert.equal(kb.inline_keyboard[0].length, 5);
  assert.equal(kb.inline_keyboard[0][0].text, "1");
  assert.equal(kb.inline_keyboard[0][0].callback_data, "i:100");
  assert.equal(kb.inline_keyboard[2][1].text, "12");
});

test("removal asks before doing", () => {
  const kb = confirmRemoveKeyboard(3);
  assert.deepEqual(allData(kb), ["R:3", "i:3"]);
});

test("the item card offers size, every, price, history, remove — pause/resume retired", () => {
  const data = allData(itemKeyboard(1));
  assert.deepEqual(data, ["s:1", "e:1", "t:1", "h:1", "r:1", "L"]);
  assert.ok(!data.some((d) => d.startsWith("p:") || d.startsWith("u:")), "no pause/resume button");
});

test("target presets label the resulting price and encode only the percentage", () => {
  const kb = targetKeyboard(3, 64, { hasTarget: false });
  assert.deepEqual(allData(kb), ["T:3:10", "T:3:20", "T:3:30", "i:3"]);
  assert.ok(allText(kb).includes("−10% (≈57.60)"), "shows the computed target, not just the %");
  // Clear only appears when there's a target to clear.
  assert.ok(!allData(kb).includes("T:3:0"));
  assert.ok(allData(targetKeyboard(3, 64, { hasTarget: true })).includes("T:3:0"), "Clear when a target exists");
  // With no known price yet, buttons still work but carry no misleading number.
  assert.ok(!allText(targetKeyboard(3, 0)).some((t) => t.includes("≈")));
});

test("the /setevery flow: interval picker then three scopes, payload survives in arg", () => {
  assert.deepEqual(allData(setEveryIntervalKeyboard()), ["Pi:_:3h", "Pi:_:6h", "Pi:_:12h", "Pi:_:1d", "P"]);
  // The filler '_' drops out; the interval rides in arg through parseCallback.
  assert.deepEqual(parseCallback("Pi:_:6h"), { action: "Pi", subId: undefined, arg: "6h" });
  // Free / Bot-protected / Both — free and defended can be tuned independently.
  assert.deepEqual(allData(setEveryScopeKeyboard("1d")), ["Pf:_:1d", "Pd:_:1d", "Pa:_:1d", "Pe"]);
  assert.deepEqual(parseCallback("Pf:_:1d"), { action: "Pf", subId: undefined, arg: "1d" });
});

test("/prefs offers both default-sizes and check-frequency, and the size flow picks a category", () => {
  assert.deepEqual(allData(prefsKeyboard()), ["Ps", "Pe"]);
  assert.deepEqual(allData(prefsSizeCategoryKeyboard(["tops", "bottoms", "shoes"])),
    ["Pc:_:tops", "Pc:_:bottoms", "Pc:_:shoes", "P"]);
  assert.deepEqual(parseCallback("Pc:_:shoes"), { action: "Pc", subId: undefined, arg: "shoes" });
});

test("every-keyboard offers exactly the supported intervals", () => {
  assert.deepEqual(allData(everyKeyboard(2)), ["E:2:3h", "E:2:6h", "E:2:12h", "E:2:1d", "i:2"]);
});
