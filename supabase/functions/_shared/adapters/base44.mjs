// Base44 — the AI app-builder platform (Wix-owned) that a lot of small,
// hand-made shops are now generated on.
//
// FOUND THE HARD WAY. shoptsuchi.com was accepted at /add because its HTML
// contains `application/ld+json`, and then failed every single check: the only
// JSON-LD on the page is WebSite, Organization and BreadcrumbList. The product
// itself never appears in the HTML at all — it's a 6.7KB shell with a Vite
// bundle, and even og:title is the literal word "product".
//
// The data comes from an endpoint that is PUBLIC and unauthenticated:
//   GET {origin}/api/apps/{appId}/entities/Product
// returning the whole catalogue as JSON, each row carrying exactly what a price
// tracker needs: title, price, in_stock, size, id. The product id is the last
// path segment of the URL, so no search or matching is required.
//
// Like Shopify's /products/{handle}.js and WooCommerce's Store API, this is a
// PLATFORM adapter: it works on every Base44 shop, not just the one that
// exposed it.
//
// TWO HONEST LIMITS, both visible to the user rather than papered over:
//   - No currency field anywhere in the payload, and none in public-settings.
//     We do not invent one. The reading carries an empty currency and the bot
//     prints the bare number, which is the truth: we know the price, not the
//     denomination.
//   - `size` is a single string per product ("large"), not a variant list. So
//     this is product-level: we can say the price moved or it sold out, not
//     that your size came back.

import { httpGet } from "../fetcher.mjs";
import { STATE } from "../stock.mjs";
import { parseMoney } from "../money.mjs";

/** The 24-hex id Base44 uses for both apps and records. */
const OBJECT_ID = /^[0-9a-f]{24}$/i;

/** The product id is simply the last path segment. */
export function productIdOf(url) {
  try {
    const seg = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "";
    return OBJECT_ID.test(seg) ? seg : undefined;
  } catch { return undefined; }
}

/**
 * The app id, which the shop's own HTML leaks in its asset URLs:
 *   https://media.base44.com/images/public/{appId}/…
 * It also appears in the JS bundle, but the page is smaller and always present.
 */
export function appIdOf(html) {
  const m = String(html).match(/base44\.com\/images\/public\/([0-9a-f]{24})/i)
    ?? String(html).match(/["']([0-9a-f]{24})["']/);
  return m?.[1];
}

/** Is this a Base44-built shop? Used by the router, so it must be cheap. */
export function isBase44(html) {
  return /base44\.(com|app)/i.test(String(html));
}

/**
 * @param {object[]} catalogue  rows from the entities endpoint
 * @param {import("../types.mjs").Item} item
 */
export function parseBase44(catalogue, item, checkedAt = new Date().toISOString()) {
  if (!Array.isArray(catalogue)) {
    return { ok: false, kind: "parse", message: "base44: entities endpoint did not return a list", checkedAt };
  }
  const wanted = productIdOf(item.url);
  const row = catalogue.find((p) => p?.id === wanted);
  if (!row) {
    // The catalogue loaded and this product isn't in it — it was delisted, not
    // a broken read. Say which, so it doesn't look like a parse failure.
    return {
      ok: false, kind: "soft",
      message: `base44: the shop lists ${catalogue.length} products and this one isn't among them (delisted?)`,
      checkedAt,
    };
  }

  const price = parseMoney(row.price);
  if (price == null) {
    return { ok: false, kind: "soft", message: "base44: product has no price", checkedAt };
  }

  // in_stock is a real boolean here — no inference needed, which is rare enough
  // to be worth noting. Anything that isn't an explicit true is NOT buyable.
  const available = row.in_stock === true;
  const label = row.size ? String(row.size) : "One size";

  return {
    ok: true,
    price,
    // No currency is published anywhere in the payload. Inventing one is how a
    // tracker tells someone a wrong number, so we leave it empty.
    currency: item.currency ?? "",
    available,
    variants: [{
      id: String(row.id),
      label,
      price,
      available,
      state: available ? STATE.IN_STOCK : STATE.OUT_OF_STOCK,
      sizeCode: row.size ? String(row.size) : undefined,
    }],
    title: row.title ? String(row.title).trim() : undefined,
    checkedAt,
  };
}

/** @param {import("../types.mjs").Item} item */
export async function readBase44(item) {
  const checkedAt = new Date().toISOString();
  if (!productIdOf(item.url)) {
    return { ok: false, kind: "parse", message: "base44: no product id in the URL", checkedAt };
  }

  // THE APP ID COMES FROM STORAGE FIRST, AND THE PAGE ONLY AS A FALLBACK.
  //
  // The first version fetched the page on EVERY check to re-derive an id that
  // never changes, justified in a comment as avoiding an id that "would
  // silently rot". That was backwards: it made a product whose data was
  // perfectly readable depend on a page we did not need. Live proof — her shop
  // started returning HTTP 402 "App Unavailable - Base44" (a billing/quota lapse
  // on the shop's side) while the catalogue API kept serving 200 with the full
  // product list. The item went dark for a reason that had nothing to do with
  // the item.
  let appId = item.variantSelector?.appId;
  if (!appId) {
    const page = await httpGet(item.url, { headers: { accept: "text/html" } });
    if (!page.ok) {
      // Say what actually happened. "Couldn't find the app id on the page" blamed
      // our parsing for what was really the shop being down.
      const kind = page.status === 403 ? "blocked" : page.error === "timeout" ? "timeout" : "http";
      return {
        ok: false, kind, status: page.status,
        message: `base44: the shop's page returned ${page.status || page.error}` +
                 (page.status === 402 ? " — the shop is unavailable on Base44 (billing or quota)" : ""),
        checkedAt,
      };
    }
    appId = appIdOf(page.body ?? "");
  }
  if (!appId) {
    return { ok: false, kind: "soft", message: "base44: couldn't find the app id on the page", checkedAt };
  }

  const origin = new URL(item.url).origin;
  const r = await httpGet(`${origin}/api/apps/${appId}/entities/Product`, {
    headers: { accept: "application/json", "x-app-id": appId },
  });
  if (!r.ok) {
    const kind = r.status === 403 ? "blocked" : r.error === "timeout" ? "timeout" : "http";
    return { ok: false, kind, status: r.status, message: `base44: catalogue fetch failed (${r.status || r.error})`, checkedAt };
  }

  let catalogue;
  try { catalogue = JSON.parse(r.body); }
  catch { return { ok: false, kind: "parse", message: "base44: catalogue was not JSON", checkedAt }; }

  return parseBase44(catalogue, item, checkedAt);
}
