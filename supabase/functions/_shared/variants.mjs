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
