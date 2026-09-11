// Matching a human's words ("M", "UK9", "size 32") against the size labels a
// shop actually returned ("colour 69 / size 032", "UK9/EU43", "M").
//
// Shared because two callers must agree: /size (the user picks now) and the
// checker (applying a saved default at the first reading). If they disagreed,
// "UK9" could mean one variant when typed and another when defaulted — the kind
// of silent mismatch that shows up as a missed restock months later.

const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Exact on any field first, then prefix, then substring. Exactness is checked
 * across ALL variants before falling back, so "M" matches size M rather than
 * prefix-matching "Mint".
 *
 * @param {{id:string,label:string,sizeCode?:string}[]} variants
 * @param {string} input
 */
export function matchVariant(variants, input) {
  const want = norm(input);
  if (!want || !Array.isArray(variants)) return null;
  const fields = (v) => [v.label, v.sizeCode, v.id].map(norm).filter(Boolean);
  return variants.find((v) => fields(v).some((f) => f === want))
    ?? variants.find((v) => fields(v).some((f) => f.startsWith(want)))
    ?? variants.find((v) => fields(v).some((f) => f.includes(want)))
    ?? null;
}

/**
 * The variant a URL already named, if the reading contains it.
 *
 * /add parses the shop's own codes out of the link into variant_selector —
 * Uniqlo's { colorDisplayCode: "06", sizeDisplayCode: "006" } is the colour and
 * size the shopper was actually looking at. Matching on BOTH is the point: this
 * cardigan has three colours and six sizes, so a size alone picks the right row
 * in the wrong colour.
 *
 * Returns null unless every code the URL specified is matched — a partial match
 * is a guess, and guessing which variant someone meant is indistinguishable from
 * working right up until the restock they miss.
 */
export function variantFromSelector(variants, selector) {
  if (!Array.isArray(variants) || !selector || typeof selector !== "object") return null;
  const size = selector.sizeDisplayCode ?? selector.sizeCode ?? selector.size;
  const colour = selector.colorDisplayCode ?? selector.colourCode ?? selector.color;
  if (size == null && colour == null) return null;
  const same = (a, b) => a != null && b != null && String(a).trim() === String(b).trim();
  return variants.find((v) =>
    (size == null || same(v.sizeCode, size)) &&
    (colour == null || same(v.colorCode, colour))) ?? null;
}
