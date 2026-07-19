// & Other Stories (H&M group). The frontend is defended (Forter), but the product
// page embeds a per-size array with name + availability + sku — verified
// consistent with the free /api/products/{code}/stock/ endpoint. We fetch the
// page through the unblocker and read that array; price comes from the page's
// JSON-LD offer.
//
//   "sizes":[ {"name":"36","sku":"1334485001003","available":true,"stock":"yes"}, ... ]
//
// Track a size via variantSelector { size } (the size NAME, e.g. "36").

import { fetchMaybeUnblocked } from "../unblocker.mjs";
import { parseJsonLd } from "./jsonld.mjs";

/**
 * @param {string} html
 * @param {import("../types.mjs").Item} item
 * @returns {import("../types.mjs").ReadResult}
 */
export function parseStories(html, item) {
  const checkedAt = new Date().toISOString();
  // The size array is flat (no nested arrays), so [^\]]* is safe; pick the one
  // carrying sku + name (not image-size arrays).
  const cands = [...String(html).matchAll(/"sizes"\s*:\s*(\[[^\]]*\])/g)].map((m) => m[1]);
  const raw = cands.find((c) => c.includes('"sku"') && c.includes('"name"'));
  let sizes;
  try { sizes = raw ? JSON.parse(raw) : null; } catch { sizes = null; }
  if (!Array.isArray(sizes) || sizes.length === 0) {
    return { ok: false, kind: "parse", message: "stories: no sizes[] with sku found (shape changed?)", checkedAt };
  }

  const ld = parseJsonLd(html, item); // page ships a ProductGroup for price
  const price = ld.ok ? ld.price : undefined;
  const currency = (ld.ok && ld.currency) || item.currency || "";

  const variants = sizes.map((s) => ({
    id: String(s.sku),
    label: String(s.name ?? s.sku),
    price,
    available: s.available === true || s.stock === "yes",
    sizeCode: s.name != null ? String(s.name) : undefined,
  }));

  const sel = item.variantSelector ?? {};
  const chosen = sel.size != null
    ? variants.find((v) => v.sizeCode === String(sel.size))
    : item.variantId ? variants.find((v) => v.id === String(item.variantId)) : undefined;
  if (sel.size != null && !chosen) {
    return { ok: false, kind: "parse", message: `stories: size ${sel.size} not in sizes`, checkedAt };
  }
  const available = chosen ? chosen.available : variants.some((v) => v.available);
  return { ok: true, price: chosen?.price ?? price, currency, available, variants, checkedAt };
}

/** @param {import("../types.mjs").Item} item */
export async function readStories(item, ctx = {}) {
  const checkedAt = new Date().toISOString();
  const res = await fetchMaybeUnblocked(item, {
    apiKey: ctx.unblockerKey,
    country: "sg",
    validate: (html) => /"sizes"\s*:\s*\[[^\]]*"sku"/.test(html),
  });
  if (!res.ok) {
    const kind = res.status === 403 ? "blocked" : res.error === "timeout" ? "timeout" : "http";
    return { ok: false, kind, status: res.status, message: `stories: ${res.message}`, checkedAt };
  }
  return parseStories(res.html, item);
}
