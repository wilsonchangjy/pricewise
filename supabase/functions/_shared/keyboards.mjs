// Inline keyboards. Pure builders + a parser, so the whole interaction model is
// unit-testable without Telegram.
//
// Two constraints shape everything here:
//
//  1. callback_data is capped at 64 BYTES. So the encoding is terse:
//     "<action>:<subscriptionId>[:<arg>]".
//  2. callback_data is USER-SUPPLIED. Anyone can send any bytes they like, so the
//     subscription id in it is a claim, not a fact — the handler re-checks
//     ownership every time. Never trust a button just because we drew it.
//
// One message is edited in place as the user drills down (list -> item -> size),
// rather than spawning a new message per tap. A wishlist bot people keep for
// months shouldn't leave a trail of dead menus.

const MAX_BUTTON_ROWS = 8;

/** "s:12:UK9" -> { action:"s", subId:12, arg:"UK9" } */
export function parseCallback(data) {
  const raw = String(data ?? "");
  const [action, subId, ...rest] = raw.split(":");
  if (!action) return null;
  const arg = rest.join(":") || undefined; // variant ids may contain colons
  const id = Number(subId);
  return { action, subId: Number.isInteger(id) ? id : undefined, arg };
}

const btn = (text, data) => ({ text, callback_data: data });

/** Numbered buttons under /list — tapping one opens that item. */
export function listKeyboard(subs) {
  const rows = [];
  for (let i = 0; i < subs.length; i += 5) {
    rows.push(subs.slice(i, i + 5).map((s, j) => btn(String(i + j + 1), `i:${s.id}`)));
  }
  return { inline_keyboard: rows.slice(0, MAX_BUTTON_ROWS) };
}

/** The per-item action menu. The Size button is hidden for items with a single
 *  option (one size, one variant) — there'd be nothing to pick. */
export function itemKeyboard(subId, { showSize = true } = {}) {
  const row1 = showSize
    ? [btn("📏 Size", `s:${subId}`), btn("⏱ Every", `e:${subId}`)]
    : [btn("⏱ Every", `e:${subId}`)];
  return {
    inline_keyboard: [
      row1,
      [btn("🎯 Price", `t:${subId}`), btn("📈 History", `h:${subId}`)],
      [btn("🗑 Remove", `r:${subId}`), btn("◀︎ Back", "L")],
    ],
  };
}

/** Preset drop targets, as a % below the last price we saw. No typing needed —
 *  the reference price only labels the buttons; the handler recomputes from the
 *  live price so a stale button can't set a target off an out-of-date number. */
export function targetKeyboard(subId, refPrice, { hasTarget = false } = {}) {
  const label = (pct) => {
    const at = refPrice > 0 ? ` (≈${(refPrice * (1 - pct / 100)).toFixed(2)})` : "";
    return `−${pct}%${at}`;
  };
  return {
    inline_keyboard: [
      [btn(label(10), `T:${subId}:10`), btn(label(20), `T:${subId}:20`)],
      [btn(label(30), `T:${subId}:30`), ...(hasTarget ? [btn("✖️ Clear", `T:${subId}:0`)] : [])],
      [btn("◀︎ Back", `i:${subId}`)],
    ],
  };
}

// ── /prefs and the /setevery scope flow ─────────────────────────────────────
// These carry no subscription id, so their payload rides in the ARG slot with a
// filler in the subId position ("Pi:_:6h"): parseCallback keeps only an integer
// subId, so "_" drops out and "6h" survives as arg. They're dispatched BEFORE
// the per-item ownership lookup, alongside "L".

export function prefsKeyboard() {
  return { inline_keyboard: [[btn("📏 Default sizes", "Ps"), btn("⏱ Check frequency", "Pe")]] };
}

/** Default-size flow: pick the category, then the bot asks you to type the size
 *  (sizes are free-form — UK9, M, 32 — so there's no sensible preset). */
export function prefsSizeCategoryKeyboard(categories) {
  const emoji = { tops: "👕", bottoms: "👖", shoes: "👟" };
  return {
    inline_keyboard: [
      (categories ?? []).map((c) => btn(`${emoji[c] ?? ""} ${c}`.trim(), `Pc:_:${c}`)),
      [btn("◀︎ Back", "P")],
    ],
  };
}

/** Step 1 of /setevery: pick an interval. */
export function setEveryIntervalKeyboard() {
  return {
    inline_keyboard: [
      ["3h", "6h", "12h", "1d"].map((v) => btn(v, `Pi:_:${v}`)),
      [btn("◀︎ Back", "P")],
    ],
  };
}

/** Step 2: which items should that interval apply to? Three scopes so the free
 *  and bot-protected (credit-spending) items can be tuned independently. */
export function setEveryScopeKeyboard(interval) {
  return {
    inline_keyboard: [
      [btn("Free items", `Pf:_:${interval}`)],
      [btn("Bot-protected", `Pd:_:${interval}`)],
      [btn("Both", `Pa:_:${interval}`)],
      [btn("◀︎ Back", "Pe")],
    ],
  };
}

/** A button's size text — just the size, with any leading "colour X / " dropped
 *  (it's redundant on the size picker, and it was pushing the size off-screen). */
export function variantSizeLabel(v) {
  const stripped = String(v?.label ?? "").replace(/^colou?r\s+\S+\s*[/·]\s*/i, "").trim();
  return stripped || String(v?.sizeCode ?? v?.id ?? "?");
}

/** Distinct colour codes in first-seen order — empty when the item has no colour
 *  dimension (most stores: the size IS the whole label). */
export function variantColours(variants) {
  const seen = [];
  for (const v of variants ?? []) {
    const c = v?.colorCode;
    if (c != null && c !== "" && !seen.includes(String(c))) seen.push(String(c));
  }
  return seen;
}

/**
 * The size picker — the reason this feature exists. Instead of guessing what to
 * type, the user sees exactly what the shop offers, with stock marked. Labels
 * show the size alone; when an item spans several colours the caller filters to
 * one colour first (colourKeyboard) so this list stays short and legible.
 */
export function sizeKeyboard(subId, variants, currentVariantId, { back = `i:${subId}`, includeAny = true } = {}) {
  const rows = [];
  const usable = (variants ?? []).filter((v) => v && v.label).slice(0, 30);
  for (let i = 0; i < usable.length; i += 3) {
    rows.push(
      usable.slice(i, i + 3).map((v) => {
        const chosen = currentVariantId && String(v.id) === String(currentVariantId);
        const mark = chosen ? "✅ " : v.available ? "" : "✖️ ";
        return btn(`${mark}${short(variantSizeLabel(v), 16)}`, `S:${subId}:${v.id}`);
      }),
    );
  }
  const footer = [];
  if (includeAny) footer.push(btn("Any size", `S:${subId}:*`));
  footer.push(btn("◀︎ Back", back));
  rows.push(footer);
  return { inline_keyboard: rows };
}

/** Shown only when an item has more than one colour: pick the colour, then its
 *  sizes. Keeps a 4-colour × 7-size item from becoming 28 look-alike buttons. */
export function colourKeyboard(subId, variants, currentVariantId) {
  const colours = variantColours(variants);
  const current = currentVariantId
    ? String((variants.find((v) => String(v.id) === String(currentVariantId)) || {}).colorCode ?? "")
    : "";
  const rows = [];
  for (let i = 0; i < colours.length; i += 2) {
    rows.push(colours.slice(i, i + 2).map((c) =>
      btn(`${c === current ? "✅ " : ""}colour ${c}`, `cc:${subId}:${c}`)));
  }
  rows.push([btn("Any colour & size", `S:${subId}:*`), btn("◀︎ Back", `i:${subId}`)]);
  return { inline_keyboard: rows };
}

export function everyKeyboard(subId) {
  return {
    inline_keyboard: [
      [btn("3h", `E:${subId}:3h`), btn("6h", `E:${subId}:6h`), btn("12h", `E:${subId}:12h`), btn("1d", `E:${subId}:1d`)],
      [btn("◀︎ Back", `i:${subId}`)],
    ],
  };
}

/** Removal is the one irreversible action here, so it asks first. */
export function confirmRemoveKeyboard(subId) {
  return {
    inline_keyboard: [
      [btn("Yes, stop tracking", `R:${subId}`), btn("Cancel", `i:${subId}`)],
    ],
  };
}

export const backToItemKeyboard = (subId) => ({ inline_keyboard: [[btn("◀︎ Back", `i:${subId}`)]] });

/** Telegram truncates long button text badly; do it ourselves, legibly. */
function short(label, max = 18) {
  const s = String(label);
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}
