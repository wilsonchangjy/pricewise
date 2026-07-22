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

/** The per-item action menu. */
export function itemKeyboard(subId) {
  // Pause/Resume was retired — the use case proved vanishingly rare. The mute
  // capability still exists in the callback handler for any stale buttons, it's
  // just no longer offered here or as a command.
  return {
    inline_keyboard: [
      [btn("📏 Size", `s:${subId}`), btn("⏱ Every", `e:${subId}`)],
      [btn("📈 History", `h:${subId}`), btn("🗑 Remove", `r:${subId}`)],
      [btn("◀︎ Back", "L")],
    ],
  };
}

/**
 * The size picker — the reason this feature exists. Instead of guessing what to
 * type, the user sees exactly what the shop offers, with stock marked.
 */
export function sizeKeyboard(subId, variants, currentVariantId) {
  const rows = [];
  const usable = (variants ?? []).filter((v) => v && v.label).slice(0, 24);
  for (let i = 0; i < usable.length; i += 3) {
    rows.push(
      usable.slice(i, i + 3).map((v) => {
        const chosen = currentVariantId && String(v.id) === String(currentVariantId);
        const mark = chosen ? "✅ " : v.available ? "" : "✖️ ";
        return btn(`${mark}${short(v.label)}`, `S:${subId}:${v.id}`);
      }),
    );
  }
  rows.push([btn("Any size", `S:${subId}:*`), btn("◀︎ Back", `i:${subId}`)]);
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
