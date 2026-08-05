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
import { landedElsewhere, landedElsewhereResult } from "../landed.mjs";

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
  // Attribute quoting is optional in HTML and eBay omits it, so accept
  // type="application/ld+json", type='...' and bare type=application/ld+json.
  const blocks = [
    ...String(html).matchAll(
      /<script[^>]*type=["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi,
    ),
  ].map((m) => m[1].trim());

  // Collect EVERY product node on the page, not the first one. A page can carry
  // several: a "you may also like" carousel, or — the case that burned us — a
  // brand LISTING page reached by a geo-redirect, where the first Product is
  // simply whatever sits top-left in the grid. Reading that one produced a
  // confident, wrong answer: "OUR LEGACY Black Mini Jacket, USD 720" for a page
  // that is Black Camion Boots at USD 760.
  const nodes = [];
  for (const b of blocks) {
    try { collectProductNodes(JSON.parse(b), nodes); } catch { /* not JSON */ }
  }
  if (!nodes.length) return { ok: false, kind: "parse", message: "no JSON-LD Product/ProductGroup found", checkedAt };

  const node = chooseProductNode(nodes, item);
  if (!node) {
    // Several products and none of them is the one we asked for. That is a
    // listing page, or a redirect that landed somewhere else. Refusing costs a
    // check; guessing costs the user's trust in every price we ever print.
    return {
      ok: false, kind: "soft",
      message: `page has ${nodes.length} products and none matches the requested item (listing page or redirect?)`,
      checkedAt,
    };
  }

  if (isType(node, "ProductGroup") && Array.isArray(node.hasVariant) && node.hasVariant.length) {
    return fromProductGroup(node, item, checkedAt);
  }
  return fromProduct(node, item, checkedAt);
}

/**
 * The fetch gate for every adapter that reads through parseJsonLd (Zara,
 * Farfetch, MR PORTER). One definition so the three can't drift apart.
 *
 * It asks for the two things the parser refuses without: a Product/ProductGroup
 * node, and an offers block. Checking merely "the page contains JSON-LD" — as
 * Zara's gate did — passes on breadcrumb and organisation markup, so category
 * pages and challenge shells were accepted and then failed the parse, without
 * ever escalating a tier.
 */
export function hasJsonLdProduct(html) {
  const s = String(html);
  return /"@type"\s*:\s*"(ProductGroup|Product)"/.test(s) && /"offers"\s*:/.test(s);
}

/**
 * A displayable title from a Product node. Some stores (Farfetch especially)
 * put only the bare product name in JSON-LD — "small Croissant bag in leather"
 * — with the label everyone recognises, the BRAND, in a separate field. Prepend
 * it unless the name already leads with it, so alerts read "LEMAIRE small
 * Croissant bag in leather" rather than a brand-less fragment.
 */
export function titleOf(node) {
  const name = node?.name != null ? String(node.name).trim() : "";
  if (!name) return undefined;
  const brand = String(node?.brand?.name ?? (typeof node?.brand === "string" ? node.brand : "")).trim();
  if (!brand) return name;
  return new RegExp(`^${brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(name)
    ? name
    : `${brand} ${name}`;
}

function fromProduct(node, item, checkedAt) {
  const offer = offerOf(node);
  if (!offer) return { ok: false, kind: "parse", message: "JSON-LD Product has no offers", checkedAt };
  const price = priceOf(offer);
  const currency = currencyOf(offer) ?? item.currency ?? "";
  const available = availOf(offer);
  const compareRaw = compareAtOf(offer);
  const compareAtPrice = compareRaw && price != null && compareRaw > price ? compareRaw : undefined;
  return { ok: true, price, currency, compareAtPrice, available, variants: [{ id: "default", label: item.label, price, available }], title: titleOf(node), checkedAt };
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
  return { ok: true, price, currency, compareAtPrice, available, variants, title: titleOf(node), checkedAt };
}

function isType(node, type) {
  const t = node?.["@type"];
  return t === type || (Array.isArray(t) && t.includes(type));
}

// Every Product / ProductGroup on the page. We don't descend into hasVariant, so
// a ProductGroup is collected whole (not its child Products).
function collectProductNodes(node, out) {
  if (Array.isArray(node)) {
    for (const x of node) collectProductNodes(x, out);
    return out;
  }
  if (node && typeof node === "object") {
    if (isType(node, "Product") || isType(node, "ProductGroup")) { out.push(node); return out; }
    if (Array.isArray(node["@graph"])) {
      for (const x of node["@graph"]) collectProductNodes(x, out);
    }
  }
  return out;
}

/**
 * Which of these products is the one whose URL we asked for?
 *
 * One product on the page is the ordinary case — take it, exactly as before.
 * More than one and we have to prove identity rather than assume position: match
 * on the node's own url/@id, or on an id (sku / productID / mpn) that appears in
 * the URL we requested. SSENSE puts `18122381` in both, which is what makes this
 * decidable at all.
 *
 * Returns null when it can't be decided — the caller refuses. That's the whole
 * point: an unrecognised page must never be read as if it were recognised.
 */
function chooseProductNode(nodes, item) {
  if (nodes.length === 1) return nodes[0];

  const reqUrl = String(item?.url ?? "");
  if (!reqUrl) return null;

  let reqPath = reqUrl;
  try { reqPath = new URL(reqUrl).pathname.replace(/\/+$/, "").toLowerCase(); } catch { /* keep raw */ }

  const sameUrl = (n) => {
    const raw = n?.url ?? n?.["@id"];
    if (!raw) return false;
    try {
      return new URL(String(raw), reqUrl).pathname.replace(/\/+$/, "").toLowerCase() === reqPath;
    } catch { return false; }
  };

  // Ids are only usable as evidence when they're distinctive — a two-character
  // sku matches half the page by accident.
  const idIn = (n) => [n?.sku, n?.productID, n?.mpn, n?.gtin13]
    .filter((v) => v != null && String(v).length >= 4)
    .some((v) => reqPath.includes(String(v).toLowerCase()));

  return nodes.find(sameUrl) ?? nodes.find(idIn) ?? null;
}

/** @param {import("../types.mjs").Item} item */
export async function readJsonLd(item) {
  const checkedAt = new Date().toISOString();
  const r = await httpGet(item.url, { headers: { accept: "text/html" } });
  if (!r.ok) {
    const kind = r.status === 403 ? "blocked" : r.error === "timeout" ? "timeout" : "http";
    return { ok: false, kind, status: r.status, message: `page fetch failed (${r.status || r.error})`, checkedAt };
  }
  // This adapter is the catch-all for shops nobody has hand-written a reader
  // for, which makes it the one most likely to be pointed at a page that
  // redirects. Check before parsing, not after.
  const off = landedElsewhere({ requestedUrl: item.url, html: r.body, finalUrl: r.url });
  if (off.away) return landedElsewhereResult("page", off.landedOn, checkedAt);
  return parseJsonLd(r.body, item);
}
