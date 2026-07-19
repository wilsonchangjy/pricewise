// Parse-validation + soft-failure detection — the hardening the eng review
// adopted. A reading can be HTTP 200 and still be wrong (stale "InStock",
// missing variants). We refuse to silently trust those: a parsed-but-invalid
// reading is treated as unreadable and surfaced, not stored as truth.

/**
 * Hard sanity checks on a freshly parsed reading.
 * @param {import("./types.mjs").Item} item
 * @param {import("./types.mjs").Reading} reading
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function validateReading(item, reading) {
  const problems = [];
  if (typeof reading.price !== "number" || !Number.isFinite(reading.price) || reading.price <= 0) {
    problems.push("price missing or not a positive number");
  }
  if (!reading.currency) {
    problems.push("currency missing");
  }
  if (!Array.isArray(reading.variants) || reading.variants.length === 0) {
    problems.push("no variants parsed");
  }
  if (item.variantId && Array.isArray(reading.variants)) {
    const found = reading.variants.some((v) => v.id === String(item.variantId));
    if (!found) problems.push(`chosen variant ${item.variantId} not in parsed variants`);
  }
  return { ok: problems.length === 0, problems };
}

/**
 * Soft-failure: the SHAPE regressed versus what we saw before. e.g. a parser
 * that used to return 7 variants now returns 0 — almost certainly the site
 * changed, not that every size vanished. Catch it instead of "silently fine".
 * @param {import("./types.mjs").ItemState|undefined} prevState
 * @param {import("./types.mjs").Reading} reading
 * @returns {string[]}
 */
export function detectShapeRegression(prevState, reading) {
  const problems = [];
  const prevCount = prevState?.lastVariantCount;
  if (typeof prevCount === "number" && prevCount > 0 && reading.variants.length === 0) {
    problems.push(`variant count dropped ${prevCount} -> 0 (parser likely broke)`);
  }
  return problems;
}
