// WooCommerce — the long tail, the way Shopify already is.
//
// ~6.8M stores run WooCommerce (roughly a third of all identifiable shops), and
// like Shopify it answers WITHOUT a key: the Store API at
// /wp-json/wc/store/v1/ is public, unauthenticated, and free. So this is a
// FREE adapter, detected by probe rather than by hostname — one adapter, an
// enormous number of independent brands.
//
// TWO SOURCES, EACH FOR WHAT IT'S BEST AT:
//
//   Store API (?slug=…)  — authoritative price AND currency_code, plus the
//     product id, type and the list of variations.
//   The product PAGE's `data-product_variations` blob — every variation's
//     is_in_stock in ONE fetch. Fetching stock per size from the API instead
//     would cost one request per size.
//
// ⚠️ WHY NOT JUST parseJsonLd: multi-currency stores (a very common plugin)
// emit inconsistent JSON-LD. Measured on a live store: the Store API reported
// AED, the page displayed a converted "$217.83", and the JSON-LD carried the
// AED NUMBER under a USD LABEL — which would have reported a 800 AED dress as
// $800. The Store API's currency_code is the one field that isn't guessing.

import { httpGet } from "../fetcher.mjs";
import { STATE, isBuyable } from "../stock.mjs";
import { decodeEntities } from "../text.mjs";

const API = "/wp-json/wc/store/v1/products";
const MAX_VARIATION_FETCHES = 12; // only when the page blob is unavailable

/** The product slug is the last real path segment of a Woo permalink. */
export function slugOf(url) {
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    return parts.length ? decodeURIComponent(parts[parts.length - 1]) : null;
  } catch { return null; }
}

export const storeApiUrl = (url, query) => {
  const u = new URL(url);
  return `${u.origin}${API}${query}`;
};

/**
 * Prices arrive as integer MINOR UNITS with the exponent alongside
 * ("65000" + minor_unit 2 = 650.00), so never read them as plain numbers.
 */
export function money(prices, key = "price") {
  const raw = prices?.[key];
  if (raw == null || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) return undefined;
  const exp = Number(prices?.currency_minor_unit ?? 2);
  return n / 10 ** (Number.isFinite(exp) ? exp : 2);
}

/** Pull the variation form blob out of a product page. */
export function variationsBlob(html) {
  const m = String(html).match(/data-product_variations=(["'])([\s\S]*?)\1/i);
  if (!m) return null;
  try {
    const json = JSON.parse(decodeEntities(m[2]));
    return Array.isArray(json) ? json : null;
  } catch { return null; }
}

/** A variation's size label, whatever the store named its attribute. */
export function labelOf(attrs) {
  const vals = Object.entries(attrs ?? {})
    .filter(([, v]) => v != null && String(v).trim() !== "")
    .map(([, v]) => String(v));
  return vals.length ? vals.join(" / ") : null;
}

const stateOf = (v) => {
  if (v?.is_in_stock === false) return STATE.OUT_OF_STOCK;
  if (v?.is_in_stock === true) {
    return v?.is_purchasable === false ? STATE.OUT_OF_STOCK : STATE.IN_STOCK;
  }
  return null; // unknown shape — never guess "in stock"
};

/**
 * Pure assembly, so it can be tested without a network.
 * @param {object} product   Store API product record
 * @param {Array|null} blob  data-product_variations from the page, if we got it
 * @param {object} item
 */
export function buildReading(product, blob, item) {
  const checkedAt = new Date().toISOString();
  if (!product || typeof product !== "object") {
    return { ok: false, kind: "parse", message: "woocommerce: no product in the Store API response", checkedAt };
  }

  const currency = product.prices?.currency_code ?? item.currency ?? "";
  const title = product.name ? decodeEntities(String(product.name)).replace(/\s+/g, " ").trim() : undefined;
  const basePrice = money(product.prices, "price");
  const baseRegular = money(product.prices, "regular_price");

  let variants;
  if (Array.isArray(blob) && blob.length) {
    variants = blob.map((v) => {
      const state = stateOf(v);
      const price = Number(v.display_price);
      const regular = Number(v.display_regular_price);
      return {
        id: String(v.variation_id ?? v.sku ?? ""),
        label: labelOf(v.attributes) ?? String(v.variation_id ?? "one size"),
        price: Number.isFinite(price) ? price : basePrice,
        compareAtPrice: Number.isFinite(regular) && Number.isFinite(price) && regular > price ? regular : undefined,
        available: state !== null && isBuyable(state),
        state: state ?? STATE.OUT_OF_STOCK,
        sizeCode: labelOf(v.attributes) ?? undefined,
      };
    });
    // If a store's blob carries a shape we can't classify at all, say so rather
    // than reporting a wall of "sold out".
    if (blob.every((v) => stateOf(v) === null)) {
      return { ok: false, kind: "parse", message: "woocommerce: variation stock flags missing (shape changed?)", checkedAt };
    }
  } else {
    const state = stateOf(product) ?? (product.is_purchasable ? STATE.IN_STOCK : null);
    if (state === null) {
      return { ok: false, kind: "soft", message: "woocommerce: couldn't tell whether this product is in stock", checkedAt };
    }
    variants = [{
      id: String(product.id ?? product.sku ?? "default"),
      label: "One size",
      price: basePrice,
      compareAtPrice: baseRegular && basePrice != null && baseRegular > basePrice ? baseRegular : undefined,
      available: isBuyable(state),
      state,
    }];
  }

  // Narrow to a chosen size when the user picked one.
  const wanted = item.variantSelector?.size;
  const chosen = wanted ? variants.filter((v) => v.sizeCode === String(wanted) || v.label === String(wanted)) : variants;
  if (wanted && !chosen.length) {
    return { ok: false, kind: "parse", message: `woocommerce: size ${wanted} is no longer listed`, checkedAt };
  }

  // Headline = the cheapest size you can actually buy (a sold-out size is often
  // the cheapest one left in the data, and quoting it advertises nothing real).
  const pick = (vs) => {
    const ps = vs.map((v) => v.price).filter((p) => typeof p === "number");
    return ps.length ? Math.min(...ps) : undefined;
  };
  const price = pick(chosen.filter((v) => v.available)) ?? pick(chosen) ?? basePrice;

  return {
    ok: true,
    price,
    currency,
    compareAtPrice: chosen.find((v) => v.compareAtPrice)?.compareAtPrice
      ?? (baseRegular && price != null && baseRegular > price ? baseRegular : undefined),
    available: chosen.some((v) => v.available),
    variants: chosen,
    title,
    checkedAt,
  };
}

/** @param {import("../types.mjs").Item} item */
export async function readWoocommerce(item) {
  const checkedAt = new Date().toISOString();
  const slug = item.variantSelector?.slug ?? slugOf(item.url);
  if (!slug) {
    return { ok: false, kind: "parse", message: "woocommerce: no product slug in that link", checkedAt };
  }

  const r = await httpGet(storeApiUrl(item.url, `?slug=${encodeURIComponent(slug)}`), {
    headers: { accept: "application/json" },
  });
  if (!r.ok) {
    const kind = r.status === 403 ? "blocked" : r.error === "timeout" ? "timeout" : "http";
    return { ok: false, kind, status: r.status, message: `woocommerce: Store API failed (${r.status || r.error})`, checkedAt };
  }
  let list;
  try { list = JSON.parse(r.body); } catch {
    return { ok: false, kind: "parse", message: "woocommerce: Store API did not return JSON", checkedAt };
  }
  const product = Array.isArray(list) ? list[0] : list;
  if (!product?.id) {
    return { ok: false, kind: "parse", message: "woocommerce: that slug matched no product", checkedAt };
  }

  // Variable product → get every size's stock in ONE page fetch.
  let blob = null;
  if (Array.isArray(product.variations) && product.variations.length) {
    const page = await httpGet(product.permalink ?? item.url, { headers: { accept: "text/html" } });
    if (page.ok) blob = variationsBlob(page.body);

    // No blob (a headless or heavily customised theme): fall back to asking the
    // API for each variation. Accurate, just chattier — and capped, because a
    // 40-size product isn't worth 40 requests every check.
    if (!blob && product.variations.length <= MAX_VARIATION_FETCHES) {
      const rows = [];
      for (const v of product.variations) {
        const vr = await httpGet(storeApiUrl(item.url, `/${v.id}`), { headers: { accept: "application/json" } });
        if (!vr.ok) continue;
        try {
          const vp = JSON.parse(vr.body);
          rows.push({
            variation_id: vp.id,
            attributes: Object.fromEntries((v.attributes ?? []).map((a) => [a.name, a.value])),
            is_in_stock: vp.is_in_stock,
            is_purchasable: vp.is_purchasable,
            display_price: money(vp.prices, "price"),
            display_regular_price: money(vp.prices, "regular_price"),
          });
        } catch { /* skip this variation */ }
      }
      if (rows.length) blob = rows;
    }
  }

  return buildReading(product, blob, item);
}
