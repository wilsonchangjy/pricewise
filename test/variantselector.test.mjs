import { test } from "node:test";
import assert from "node:assert/strict";
import { variantFromSelector, matchVariant } from "../supabase/functions/_shared/variants.mjs";
import { itemKeyboard } from "../supabase/functions/_shared/keyboards.mjs";
import { localeFromUrl } from "../supabase/functions/_shared/locale.mjs";

// LIVE CASE. A Uniqlo cardigan link carried ?colorDisplayCode=06&sizeDisplayCode=006.
// /add read it correctly and said "Watching: colour 06 / size 006" — then the
// saved default size "S" resolved first and the subscription ended up on
// colour 06 / size 002, announcing "(Using your saved size S)" about a size the
// link had already specified. The item has 3 colours x 6 sizes, so a size-only
// match can also land in the wrong colour entirely.
const CARDIGAN = [
  { id: "09469062", label: "colour 06 / size 002", sizeCode: "002", colorCode: "06" },
  { id: "09469066", label: "colour 06 / size 006", sizeCode: "006", colorCode: "06" },
  { id: "09469070", label: "colour 09 / size 002", sizeCode: "002", colorCode: "09" },
  { id: "09469074", label: "colour 09 / size 006", sizeCode: "006", colorCode: "09" },
];

test("the link's own colour AND size win over a saved default", () => {
  const hit = variantFromSelector(CARDIGAN, { productCode: "E488191-000", sizeDisplayCode: "006", colorDisplayCode: "06" });
  assert.equal(hit.id, "09469066");
  // The default would have picked a different row, in this case a different size.
  assert.notEqual(matchVariant(CARDIGAN, "002")?.id, hit.id);
});

test("matching on size alone would land in the wrong colour — so both must match", () => {
  const sizeOnly = variantFromSelector(CARDIGAN, { sizeDisplayCode: "006" });
  assert.equal(sizeOnly.sizeCode, "006", "a size-only selector still resolves");
  const both = variantFromSelector(CARDIGAN, { sizeDisplayCode: "006", colorDisplayCode: "09" });
  assert.equal(both.id, "09469074", "but naming the colour pins the colour");
});

test("a selector naming nothing wearable yields null, so the default still applies", () => {
  assert.equal(variantFromSelector(CARDIGAN, { productCode: "E488191-000" }), null);
  assert.equal(variantFromSelector(CARDIGAN, null), null);
  assert.equal(variantFromSelector(null, { sizeDisplayCode: "006" }), null);
});

test("a code the reading doesn't contain is null, never an approximation", () => {
  // Watching the wrong variant is indistinguishable from working, right up
  // until the restock that never arrives.
  assert.equal(variantFromSelector(CARDIGAN, { sizeDisplayCode: "999", colorDisplayCode: "06" }), null);
});

// ── colour is its own button ─────────────────────────────────────────────────
test("a multi-colour item offers Colour and Size separately", () => {
  const data = itemKeyboard(1, { showSize: true, showColour: true, showMarket: false })
    .inline_keyboard.flat().map((b) => b.callback_data);
  assert.deepEqual(data, ["C:1", "s:1", "e:1", "t:1", "h:1", "r:1", "L"]);
});

test("a single-colour item shows no Colour button", () => {
  const data = itemKeyboard(1, { showSize: true, showColour: false, showMarket: false })
    .inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(!data.includes("C:1"));
});

// ── the locale a Farfetch share-link carries ─────────────────────────────────
// Missing this meant a US link read as "no country", so the proxy was pinned to
// SG while the URL asked for the US site. Which one won varied per check, and
// one bag reported 1247 / 1339 SGD / 1145 / 966 USD across five readings —
// firing "16% off" and then "+19%" for a price that never moved.
test("?lang=en-US is a statement about which storefront the link points at", () => {
  const u = "https://www.farfetch.com/item-22636822.aspx?c=v&is_retargeting=true&lang=en-US&pid=app-product-share";
  assert.equal(localeFromUrl(u).country, "US");
  assert.equal(localeFromUrl(u).currency, "USD");
  assert.equal(localeFromUrl("https://x.com/p?lang=en_GB").country, "GB");
});

test("a path locale still wins over nothing, and a plain link stays silent", () => {
  assert.equal(localeFromUrl("https://www.farfetch.com/sg/shopping/x.aspx").country, "SG");
  assert.equal(localeFromUrl("https://www.farfetch.com/item-1.aspx").country, undefined);
});
