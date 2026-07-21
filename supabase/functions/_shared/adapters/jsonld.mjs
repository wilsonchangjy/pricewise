// Generic JSON-LD adapter: pulls schema.org Product / ProductGroup (price +
// availability) out of any page that embeds it.
//
// Two shapes handled:
//   - Product        -> a single reading.
//   - ProductGroup   -> per-variant readings from hasVariant[] (e.g. Zara, whose
//                       JSON-LD exposes each size as a Product with its own
//                       offer + availability). This gives real PER-SIZE stock.
//
// parseJsonLd() is pure (takes HTML string) so it is unit-testable.

import { httpGet } from "../fetcher.mjs";

const offerOf = (x) => (Array.isArray(x?.offers) ? x.offers[0] : x?.offers);

// priceSpecification comes as an object on some sites and an ARRAY on others
// (Farfetch ships UnitPriceSpecification[]). Missing the array form meant
// reading a page with per-size stock and no price at all.
const specs = (offer) => {
  const ps = offer?.priceSpecification;
  return Array.isArray(ps) ? ps : ps ? [ps] : [];
};
const specOf = (offer) => specs(offer).find((x) => !/Strikethrough|ListPrice/i.test(x?.priceType ?? "")) ?? specs(offer)[0];

// The was-price rides along as a second spec entry tagged StrikethroughPrice —
// that's the "£975, 30% off" a shopper actually sees, and reading only the first
// entry threw the discount away.
const compareAtOf = (offer) => {
  const struck = specs(offer).find((x) => /Strikethrough|ListPrice/i.test(x?.priceType ?? ""));
  const raw = struck?.price ?? offer?.highPrice;
  return raw != null ? Number(raw) : undefined;
};

const priceOf = (offer) => {
  const raw = offer?.price ?? specOf(offer)?.price;
  return raw != null ? Number(raw) : undefined;
};
const currencyOf = (offer) => offer?.priceCurrency ?? specOf(offer)?.priceCurrency;
const availOf = (offer) => {
  const a = String(offer?.availability ?? "").toLowerCase();
  return a.includes("instock") || a.includes("limited");
};

/**
 * @param {string} html
 * @param {import("../types.mjs").Item} item
 * @returns {import("../types.mjs").ReadResult}
 */
export function parseJsonLd(html, item) {
  const checkedAt = new Date().toISOString();
  const blocks = [
    ...String(html).matchAll(
      /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
    ),
  ].map((m) => m[1].trim());

  let node = null;
  for (const b of blocks) {
    try {
      node = findProductNode(JSON.parse(b));
    } catch {
      node = null;
    }
    if (node) break;
  }
  if (!node) return { ok: false, kind: "parse", message: "no JSON-LD Product/ProductGroup found", checkedAt };

  if (isType(node, "ProductGroup") && Array.isArray(node.hasVariant) && node.hasVariant.length) {
    return fromProductGroup(node, item, checkedAt);
  }
  return fromProduct(node, item, checkedAt);
}

function fromProduct(node, item, checkedAt) {
  const offer = offerOf(node);
  if (!offer) return { ok: false, kind: "parse", message: "JSON-LD Product has no offers", checkedAt };
  const price = priceOf(offer);
  const currency = currencyOf(offer) ?? item.currency ?? "";
  const available = availOf(offer);
  const compareRaw = compareAtOf(offer);
  const compareAtPrice = compareRaw && price != null && compareRaw > price ? compareRaw : undefined;
  return { ok: true, price, currency, compareAtPrice, available, variants: [{ id: "default", label: item.label, price, available }], checkedAt };
}

function fromProductGroup(node, item, checkedAt) {
  const variants = node.hasVariant
    .filter((v) => isType(v, "Product") && offerOf(v))
    .map((v) => {
      const offer = offerOf(v);
      return {
        id: String(v.sku ?? v.size ?? v.name ?? ""),
        label: String(v.size ?? v.name ?? v.sku ?? "default"),
        price: priceOf(offer),
        available: availOf(offer),
        sizeCode: v.size != null && !Array.isArray(v.size) ? String(v.size) : undefined,
      };
    });
  if (!variants.length) return { ok: false, kind: "parse", message: "JSON-LD ProductGroup has no usable variants", checkedAt };

  const currency = currencyOf(offerOf(node.hasVariant.find((v) => offerOf(v)))) ?? item.currency ?? "";
  const chosen = item.variantId ? variants.find((v) => v.id === String(item.variantId)) : undefined;
  const price = chosen?.price ?? variants.find((v) => v.price != null)?.price;
  const available = chosen ? chosen.available : variants.some((v) => v.available);
  // A ProductGroup usually carries the was-price on the group offer.
  const groupOffer = offerOf(node) ?? offerOf(node.hasVariant.find((v) => offerOf(v)));
  const compareRaw = compareAtOf(groupOffer);
  const compareAtPrice = compareRaw && price != null && compareRaw > price ? compareRaw : undefined;
  return { ok: true, price, currency, compareAtPrice, available, variants, checkedAt };
}

function isType(node, type) {
  const t = node?.["@type"];
  return t === type || (Array.isArray(t) && t.includes(type));
}

// Return the Product OR ProductGroup node (whichever we hit first). We don't
// descend into hasVariant, so a ProductGroup is returned whole (not its first
// child Product).
function findProductNode(node) {
  if (Array.isArray(node)) {
    for (const x of node) {
      const f = findProductNode(x);
      if (f) return f;
    }
    return null;
  }
  if (node && typeof node === "object") {
    if (isType(node, "Product") || isType(node, "ProductGroup")) return node;
    if (Array.isArray(node["@graph"])) {
      for (const x of node["@graph"]) {
        const f = findProductNode(x);
        if (f) return f;
      }
    }
  }
  return null;
}

/** @param {import("../types.mjs").Item} item */
export async function readJsonLd(item) {
  const checkedAt = new Date().toISOString();
  const r = await httpGet(item.url, { headers: { accept: "text/html" } });
  if (!r.ok) {
    const kind = r.status === 403 ? "blocked" : r.error === "timeout" ? "timeout" : "http";
    return { ok: false, kind, status: r.status, message: `page fetch failed (${r.status || r.error})`, checkedAt };
  }
  return parseJsonLd(r.body, item);
}
