// Products get a human name from their URL slug until a reading gives us a
// better one. "…/products/wide-leg-wool-trouser?variant=42" -> "Wide Leg Wool
// Trouser (brand.com)".

import { brandForHost, isOwnBrand } from "./stores.mjs";

const letters = (s) => (s.match(/[a-z]/gi) ?? []).length;

export function labelFromUrl(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    // Not always the LAST segment — Uniqlo ends in /E485737-000/00, Zara ends in
    // the slug. Pick the wordiest segment instead.
    const slug = u.pathname
      .split("/")
      .filter(Boolean)
      .filter((s) => !/^(products?|product-page|p|prd|dp|item|en|sg|us|shop|collections?|all)$/i.test(s))
      .sort((a, b) => letters(b) - letters(a) || b.length - a.length)[0];
    if (!slug) return host;
    const name = decodeURIComponent(slug)
      .replace(/\.(html?|js|json)$/i, "")
      .replace(/[-_+]+/g, " ")
      .replace(/\b(p?\d{5,})\b/gi, "")      // drop SKU-ish number blobs
      .replace(/\s+/g, " ")
      .trim();
    if (!name) return host;
    const titled = name.replace(/\b\w/g, (c) => c.toUpperCase());
    return `${titled} (${host})`;
  } catch {
    return url;
  }
}

/**
 * The title we SHOW: the brand, then the product.
 *
 * A tracked title comes from whatever the shop published, and plenty of shops
 * publish only the product half — "Unisex Smart Wide Straight Pants", which on a
 * list of eight items tells you nothing about which shop it's from. Prepend the
 * brand unless the title already leads with it, so nothing reads "Uniqlo Uniqlo
 * …". Same idea as jsonld's titleOf(), applied to the adapters with no brand
 * field to read.
 *
 * @param {{title?:string, url?:string}} product
 */
export function displayTitle(product) {
  const title = String(product?.title ?? "").trim();
  if (!title) return labelFromUrl(product?.url ?? "");
  let host;
  try { host = new URL(product.url).hostname; } catch { return title; }
  // A marketplace's name is not a brand — farfetch.com sells LEMAIRE, and the
  // title already says so.
  if (!isOwnBrand(host, product?.adapter)) return title;
  const brand = brandForHost(host);
  if (!brand) return title;
  // Already leads with it? Compare on letters alone, so "NET-A-PORTER" matches
  // "Net a Porter" and "& Other Stories" matches "Other Stories".
  const bare = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  return bare(title).startsWith(bare(brand)) ? title : `${brand} ${title}`;
}
