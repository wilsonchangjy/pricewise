// Products get a human name from their URL slug until a reading gives us a
// better one. "…/products/wide-leg-wool-trouser?variant=42" -> "Wide Leg Wool
// Trouser (brand.com)".

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
