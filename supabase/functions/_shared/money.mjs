// Parsing a price that a European shop wrote.
//
// THE BUG THIS EXISTS FOR, in full, because it is the worst one this project has
// had: vetsak.com (a German Shopify store) sells a sofa. Our adapter read the
// variant price correctly as 4386 EUR. The verifier fetched the same page for a
// second opinion, found the JSON-LD price written as "4.386" — German, where "."
// is the THOUSANDS separator — and Number("4.386") is 4.386. So the two sources
// "disagreed" by three orders of magnitude, the reading was marked untrusted,
// and a genuine 774-euro price drop was filtered out and never sent.
//
// The mechanism built to stop us reporting a wrong price is what suppressed a
// correct one. Nobody was told, because a suppressed alert looks exactly like a
// price that didn't move.
//
// AMBIGUITY IS REAL, and resolved deliberately:
//   "4.386"      -> 4386     dot + exactly three digits, nothing else: thousands
//   "4.38"       -> 4.38     two decimals: a decimal point
//   "1.234,56"   -> 1234.56  both separators, comma last: German
//   "1,234.56"   -> 1234.56  both separators, dot last: English
//   "1,234"      -> 1234     comma + exactly three digits: thousands
//   "4386"       -> 4386
// A price with three decimal places ("4.386" meaning four euros) is vanishingly
// rare in retail; a four-figure price with a thousands separator is everywhere.
// Where the two collide we take the common case, and say so here rather than
// leaving the next person to rediscover it.

/**
 * @param {unknown} raw
 * @returns {number|undefined} undefined when there is no number to be had —
 *   never NaN, so callers can use a plain `== null` check.
 */
export function parseMoney(raw) {
  if (raw == null) return undefined;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : undefined;

  // Strip currency symbols, codes and spaces (incl. the non-breaking kind that
  // European sites use between amount and symbol).
  let s = String(raw).trim().replace(/[\s  ]/g, "");
  s = s.replace(/[^\d.,-]/g, "");
  if (!s) return undefined;

  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");

  if (lastDot !== -1 && lastComma !== -1) {
    // Both present: whichever comes LAST is the decimal separator.
    if (lastComma > lastDot) s = s.replace(/\./g, "").replace(",", ".");
    else s = s.replace(/,/g, "");
  } else if (lastComma !== -1) {
    s = groupingOnly(s, ",") ? s.replace(/,/g, "") : s.replace(",", ".");
  } else if (lastDot !== -1) {
    if (groupingOnly(s, ".")) s = s.replace(/\./g, "");
  }

  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Is this separator grouping rather than a decimal point? True when every run
 * after a separator is exactly three digits AND there is more than one digit
 * before the first — "4.386" and "1.234.567" yes, "4.38" and "0.386" no.
 */
function groupingOnly(s, sep) {
  const parts = s.split(sep);
  if (parts.length < 2) return false;
  if (!/^-?\d{1,3}$/.test(parts[0])) return false;
  return parts.slice(1).every((p) => /^\d{3}$/.test(p));
}
