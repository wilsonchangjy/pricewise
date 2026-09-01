import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseCallback, listKeyboard, itemKeyboard, sizeKeyboard, everyKeyboard, confirmRemoveKeyboard,
  targetKeyboard, setEveryIntervalKeyboard, setEveryScopeKeyboard,
  prefsKeyboard, prefsSizeCategoryKeyboard,
  colourKeyboard, variantColours, variantSizeLabel, candidateKeyboard,
  marketKeyboard, prefsCountryKeyboard,
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

test("the item card offers size, every, price, history, market, remove — pause/resume retired", () => {
  const data = allData(itemKeyboard(1));
  assert.deepEqual(data, ["s:1", "e:1", "t:1", "h:1", "m:1", "r:1", "L"]);
  assert.ok(!data.some((d) => d.startsWith("p:") || d.startsWith("u:")), "no pause/resume button");
});

test("the Size button is hidden for a single-option item", () => {
  const data = allData(itemKeyboard(1, { showSize: false }));
  assert.ok(!data.includes("s:1"), "no size button when there's nothing to pick");
  assert.deepEqual(data, ["e:1", "t:1", "h:1", "m:1", "r:1", "L"]);
});

test("size buttons show the size alone — the redundant colour prefix is stripped", () => {
  assert.equal(variantSizeLabel({ label: "colour 69 / size 027", sizeCode: "027" }), "size 027");
  assert.equal(variantSizeLabel({ label: "M" }), "M");
  assert.equal(variantSizeLabel({ label: "colour 01 / size 002" }), "size 002");
  const kb = sizeKeyboard(5, [{ id: "a", label: "colour 69 / size 027", available: true }], null);
  assert.ok(kb.inline_keyboard.flat().some((b) => b.text.includes("size 027") && !b.text.includes("colour")));
});

test("colour picker appears only when colours vary, and leads into the size list", () => {
  const oneColour = [{ id: "a", label: "colour 69 / size 027", colorCode: "69" }, { id: "b", label: "colour 69 / size 028", colorCode: "69" }];
  const multi = [{ id: "a", label: "colour 01 / size 002", colorCode: "01" }, { id: "b", label: "colour 04 / size 002", colorCode: "04" }];
  assert.deepEqual(variantColours(oneColour), ["69"]);
  assert.deepEqual(variantColours(multi), ["01", "04"]);
  // Each colour routes to cc:<sub>:<colour>; "Any" still watches everything.
  const kb = colourKeyboard(7, multi, null);
  assert.deepEqual(allData(kb), ["cc:7:01", "cc:7:04", "S:7:*", "i:7"]);
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
  assert.deepEqual(allData(prefsKeyboard()), ["Ps", "Pe", "Pm"]);
  assert.deepEqual(allData(prefsSizeCategoryKeyboard(["tops", "bottoms", "shoes"])),
    ["Pc:_:tops", "Pc:_:bottoms", "Pc:_:shoes", "P"]);
  assert.deepEqual(parseCallback("Pc:_:shoes"), { action: "Pc", subId: undefined, arg: "shoes" });
});

test("every-keyboard offers exactly the supported intervals", () => {
  assert.deepEqual(allData(everyKeyboard(2)), ["E:2:3h", "E:2:6h", "E:2:12h", "E:2:1d", "i:2"]);
});

// A product URL is longer than callback_data's 64-byte cap, so search results
// are addressed by INDEX into the list parked on the user's row.
test("search-result buttons carry an index, never a URL", () => {
  const k = candidateKeyboard(3);
  const datas = k.inline_keyboard.flat().map((b) => b.callback_data);
  assert.deepEqual(datas, ["f:_:0", "f:_:1", "f:_:2", "fx"]);
  for (const d of datas) assert.ok(new TextEncoder().encode(d).length <= 64);

  const parsed = parseCallback("f:_:2");
  assert.equal(parsed.action, "f");
  assert.equal(parsed.arg, "2");
  assert.equal(parsed.subId, undefined, "no subscription exists yet — nothing to own");
});

test("the candidate list is capped, and always offers a way out", () => {
  assert.equal(candidateKeyboard(9).inline_keyboard[0].length, 3, "3 options is an answer; more is a menu");
  assert.deepEqual(candidateKeyboard(0).inline_keyboard, [[{ text: "None of these", callback_data: "fx" }]]);
});

// ── market pickers ──────────────────────────────────────────────────────────
// The market is part of what you're watching, not a display setting: on
// mutimer.co the same variant id is 240.00 and in stock on GB while being
// 418.00 and sold out on SG. So this had to be reachable from the item itself.

const CHOICES = [["SG", "🇸🇬 Singapore"], ["GB", "🇬🇧 UK"], ["US", "🇺🇸 US"], ["AU", "🇦🇺 Australia"], ["DE", "🇩🇪 Germany"]];

test("the per-item market picker ticks the current storefront and comes back to the item", () => {
  const kb = marketKeyboard(7, "GB", CHOICES);
  assert.deepEqual(allData(kb), ["M:7:SG", "M:7:GB", "M:7:US", "M:7:AU", "M:7:DE", "i:7"]);
  const labels = kb.inline_keyboard.flat().map((b) => b.text);
  assert.ok(labels.some((l) => l.startsWith("✓") && l.includes("UK")), "the current one is marked");
  assert.equal(labels.filter((l) => l.startsWith("✓")).length, 1);
});

test("an unpinned item has nothing ticked", () => {
  const labels = marketKeyboard(7, null, CHOICES).inline_keyboard.flat().map((b) => b.text);
  assert.equal(labels.filter((l) => l.startsWith("✓")).length, 0);
});

test("the account-default picker rides in the ARG slot, like the other prefs buttons", () => {
  assert.deepEqual(allData(prefsCountryKeyboard("SG", CHOICES)),
    ["Pn:_:SG", "Pn:_:GB", "Pn:_:US", "Pn:_:AU", "Pn:_:DE", "P"]);
  assert.deepEqual(parseCallback("Pn:_:SG"), { action: "Pn", subId: undefined, arg: "SG" });
});

test("every market button stays inside Telegram's 64-byte callback_data cap", () => {
  for (const b of marketKeyboard(999999, "SG", CHOICES).inline_keyboard.flat()) {
    assert.ok(new TextEncoder().encode(b.callback_data).length <= 64, b.callback_data);
  }
});
