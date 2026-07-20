// Stock states. Until now a variant was a boolean, which threw away signal the
// shops were already handing us: Inditex returns SHOW / SOLD_OUT / COMING_SOON,
// Uniqlo distinguishes LOW_STOCK from IN_STOCK, ASOS ships isLowInStock. All of
// that collapsed into "available: false" or "true".
//
// `available` is DELIBERATELY unchanged — it still means "buyable right now", so
// every existing alert path behaves exactly as before. `state` is additive.

export const STATE = {
  IN_STOCK: "in_stock",
  LOW_STOCK: "low_stock",     // buyable, but going
  COMING_SOON: "coming_soon", // announced, not orderable yet
  OUT_OF_STOCK: "out_of_stock",
};

/** The only two states you can actually buy in today. */
export const isBuyable = (state) => state === STATE.IN_STOCK || state === STATE.LOW_STOCK;

/** Back-compat for adapters that only know a boolean. */
export const stateFromAvailable = (available) => (available ? STATE.IN_STOCK : STATE.OUT_OF_STOCK);

/**
 * Inditex vocabulary (Massimo Dutti, Oysho, Bershka, Stradivarius). Verified
 * values: SHOW, SOLD_OUT, COMING_SOON — we saw COMING_SOON on a real Bershka
 * size and were flattening it to "sold out".
 *
 * Anything unrecognised maps to OUT_OF_STOCK: claiming buyable on a value we
 * don't understand is the expensive direction to be wrong in.
 */
export function stateFromVisibility(visibilityValue) {
  const v = String(visibilityValue ?? "").toUpperCase();
  if (v === "SHOW") return STATE.IN_STOCK;
  if (v.includes("COMING")) return STATE.COMING_SOON;
  return STATE.OUT_OF_STOCK;
}

/** Uniqlo l2s statusCode. "OUT_OF_STOCK" contains "STOCK" — the old trap. */
export function stateFromUniqlo(statusCode, quantity) {
  const s = String(statusCode ?? "").toUpperCase();
  if (s) {
    if (/OUT|SOLD/.test(s)) return STATE.OUT_OF_STOCK;
    if (s.includes("COMING")) return STATE.COMING_SOON;
    if (s.includes("LOW")) return STATE.LOW_STOCK;
    if (s.includes("STOCK")) return STATE.IN_STOCK;
    return STATE.OUT_OF_STOCK;
  }
  return Number(quantity ?? 0) > 0 ? STATE.IN_STOCK : STATE.OUT_OF_STOCK;
}

/** Human wording for messages. */
export function describeState(state) {
  switch (state) {
    case STATE.IN_STOCK: return "in stock";
    case STATE.LOW_STOCK: return "low stock";
    case STATE.COMING_SOON: return "coming soon";
    default: return "out of stock";
  }
}
