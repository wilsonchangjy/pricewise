// TEMPLATE ADAPTER — copy this file to <yourstore>.mjs and work through the
// checklist at the bottom. Not wired into the router; it exists to be copied.
//
// The job: turn a product URL into a price and PER-SIZE stock. Product-level
// "is it available" is the thing every competitor already does badly; per-size
// is why this project exists, so if a shop exposes sizes, read them.
//
// Read CONTRIBUTING.md first — particularly "known traps", which is a list of
// mistakes already made here so you don't have to repeat them.

import { fetchMaybeUnblocked } from "../unblocker.mjs";
import { STATE, isBuyable } from "../stock.mjs";
import { decodeEntities } from "../text.mjs";

/**
 * Map the shop's own stock wording to our four states.
 *
 * Return null for anything you don't recognise — the caller turns that into a
 * soft failure. Do NOT fall back to IN_STOCK: a wrong "your size is back" sends
 * someone to a sold-out page, and a shop that adds a new status word should make
 * us fail loudly rather than start lying quietly.
 *
 * @param {string} raw
 * @returns {string|null}
 */
export function stateFrom(raw) {
  switch (String(raw ?? "").toUpperCase()) {
    case "IN_STOCK":
    case "AVAILABLE":
      return STATE.IN_STOCK;
    case "LOW_STOCK":
      return STATE.LOW_STOCK;   // buyable, but going
    case "COMING_SOON":
      return STATE.COMING_SOON; // announced, NOT buyable today
    case "SOLD_OUT":
    case "OUT_OF_STOCK":
      return STATE.OUT_OF_STOCK;
    default:
      return null;
  }
}

/**
 * Pure parse: body in, reading out. Keep the network out of here so it can be
 * tested against a captured fixture.
 *
 * @param {string} body
 * @param {import("../types.mjs").Item} item
 * @returns {import("../types.mjs").ReadResult}
 */
export function parseTemplate(body, item) {
  const checkedAt = new Date().toISOString();

  // 1. TITLE. Its absence is the cheapest signal that you were served a
  //    challenge page rather than a product.
  const rawTitle = (body.match(/<title[^>]*>([^<]{3,150})/i) || [])[1];
  const title = decodeEntities(String(rawTitle ?? "")).replace(/\s+/g, " ").trim();
  if (!title) {
    return { ok: false, kind: "parse", message: "template: no product title (blocked, or the page shape changed)", checkedAt };
  }

  // 2. SIZES. Prefer whatever the shop treats as authoritative. If a quantity
  //    and a status field disagree, believe the quantity — we have shipped a
  //    sold-out item as available by trusting status:"in_stock" over quantity:0.
  const rows = []; // TODO: pull [{ id, label, rawState, price }] out of `body`

  const vocab = new Set(rows.map((r) => r.rawState));
  const variants = [];
  for (const r of rows) {
    const state = stateFrom(r.rawState);
    if (state === null) {
      return {
        ok: false,
        kind: "parse",
        message: `template: unrecognised stock vocabulary [${[...vocab].join(", ")}] (DO NOT trust this reading)`,
        checkedAt,
      };
    }
    variants.push({ id: String(r.id), label: r.label, price: r.price, available: isBuyable(state), state });
  }
  if (!variants.length) {
    return { ok: false, kind: "parse", message: "template: no sizes found", checkedAt };
  }

  // 3. NARROW to the size the user picked, if they picked one. If their size has
  //    disappeared from the shop entirely, say that rather than silently
  //    reporting on the whole product.
  const wanted = item.variantSelector?.size;
  const chosen = wanted ? variants.filter((v) => v.label === wanted) : variants;
  if (wanted && !chosen.length) {
    return { ok: false, kind: "parse", message: `template: size ${wanted} is no longer listed`, checkedAt };
  }

  // 4. HEADLINE price: the chosen variant's, else the cheapest available one.
  const prices = chosen.map((v) => v.price).filter((p) => typeof p === "number");
  const price = prices.length ? Math.min(...prices) : undefined;

  return {
    ok: true,
    price,
    currency: item.currency ?? "USD",
    available: chosen.some((v) => v.available),
    variants: chosen,
    title,
    checkedAt,
  };
}

/**
 * Fetch + parse. `validate` is the guard against the dangerous case: HTTP 200
 * with a challenge page or an empty shell in the body. Assert that the data you
 * need is actually present, so a block escalates the unblocker tier instead of
 * being parsed into confident nonsense.
 *
 * @param {import("../types.mjs").Item} item
 */
export async function readTemplate(item, ctx = {}) {
  const checkedAt = new Date().toISOString();

  const res = await fetchMaybeUnblocked(item, {
    apiKey: ctx.unblockerKey,
    provider: ctx.unblockerProvider,
    startTier: ctx.startTier,
    validate: (b) => /TODO-a-marker-that-only-a-real-product-page-has/.test(b),
  });
  if (!res.ok) {
    const kind = res.status === 403 ? "blocked" : res.error === "timeout" ? "timeout" : "http";
    return { ok: false, kind, status: res.status, message: `template: ${res.message}`, checkedAt };
  }

  const out = parseTemplate(res.html, item);
  if (out.ok) { out.tier = res.tier; out.cost = res.cost; out.remaining = res.remaining; }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECKLIST
//
//  [ ] Capture a REAL page and save it to test/fixtures/. Pick one with a
//      sold-out size — an all-available page can't tell a working parser from a
//      broken one. Trim it, then re-run the test to confirm the trimmed file
//      still exercises the path (fixtures have been trimmed so hard they lost
//      the variant under test).
//  [ ] Write the test first if you can: fixture in, expected per-size states out.
//  [ ] Check the reading against the live page WITH YOUR OWN EYES. Does size M
//      really show as sold out in the browser? This is the step that catches
//      what tests can't.
//  [ ] Wire it up: adapters/index.mjs, router.mjs (+ DEFENDED if it needs a key),
//      resolve.mjs, policy.mjs (cost tier), urlguard.mjs (canonical URL).
//  [ ] Does a query parameter change the price or stock? Preserve it in the
//      canonicaliser — otherwise two different products collapse into one row.
//  [ ] Run `node --test test/`.
// ─────────────────────────────────────────────────────────────────────────────
