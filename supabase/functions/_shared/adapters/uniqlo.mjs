// Uniqlo adapter — shape CONFIRMED live 2026-07-02 from a real SG capture.
//
// Uniqlo's storefront is a SPA; price/stock come from its commerce "l2s" API.
// The response shape (the important part our first guess got wrong):
//
//   { "status": "ok", "result": {
//       "l2s":    [ { "l2Id":"09097714", "color":{"displayCode":"69"},
//                     "size":{"displayCode":"032"}, "communicationCode":"..." }, ... ],
//       "stocks": { "09097714": { "statusCode":"IN_STOCK", "quantity":11 }, ... },
//       "prices": { "09097714": { "base":{"currency":{"code":"SGD"},"value":59.9},
//                                 "promo":null }, ... } } }
//
// KEY POINTS:
// - stocks & prices are SEPARATE maps keyed by l2Id, NOT inline on each l2s row.
// - prices are in MAJOR units (59.9 = SGD 59.90), so NO /100.
// - stock truth = statusCode. Careful: "OUT_OF_STOCK" CONTAINS "STOCK", so a naive
//   substring test is a false-positive trap — we require STOCK and forbid OUT/SOLD.
//
// Endpoint note: a plain server-side fetch returned 400 with
// {"message":"invalid or missing client id"} — the API requires the x-fr-clientid
// header the browser sends. It's a STATIC, PUBLIC token (same for every visitor,
// not account-scoped), so we hardcode it; no secret handling needed. Verified live
// 2026-07-02: this header + URL returns status:"ok". If Uniqlo ever rotates the
// client id, re-grab it from a product page's l2s request (DevTools > Network).

import { httpGet } from "../fetcher.mjs";

const CLIENT_ID = "uq.sg.web-spa"; // static public token; required or the API 400s

// Full query set the SG web app sends (matched exactly to avoid a different 400).
const API_URL = (code) =>
  `https://www.uniqlo.com/sg/api/commerce/v5/en/products/${code}/price-groups/00/l2s` +
  `?alterationId=1&withPrices=true&withStocks=true&includePreviousPrice=false` +
  `&withMemberPricing=false&httpFailure=true`;

const inStock = (statusCode, quantity) => {
  const s = String(statusCode ?? "").toUpperCase();
  if (s) return /STOCK/.test(s) && !/OUT|SOLD/.test(s); // IN_STOCK/LOW_STOCK yes; OUT_OF_STOCK no
  return Number(quantity ?? 0) > 0;
};

/**
 * @param {any} data  Parsed Uniqlo l2s response.
 * @param {import("../types.mjs").Item} item
 * @returns {import("../types.mjs").ReadResult}
 */
export function parseUniqlo(data, item) {
  const checkedAt = new Date().toISOString();
  const sel = item.variantSelector ?? {};
  const root = data?.result ?? data ?? {};
  const l2s = root.l2s;
  const stocks = root.stocks ?? {};
  const prices = root.prices ?? {};
  if (!Array.isArray(l2s) || l2s.length === 0) {
    return { ok: false, kind: "parse", message: "uniqlo: no l2s array (shape changed? VERIFY)", checkedAt };
  }

  const variants = l2s.map((l) => {
    const id = String(l.l2Id ?? l.communicationCode ?? "");
    const colorCode = l.color?.displayCode ?? l.color?.code;
    const sizeCode = l.size?.displayCode ?? l.size?.code;
    const stock = stocks[id] ?? {};
    const priceInfo = prices[id] ?? {};
    const base = priceInfo.base?.value != null ? Number(priceInfo.base.value) : undefined;
    const promo = priceInfo.promo?.value != null ? Number(priceInfo.promo.value) : undefined;
    const price = promo ?? base;
    return {
      id,
      label: `colour ${colorCode ?? "?"} / size ${sizeCode ?? "?"}`,
      price,
      compareAtPrice: promo != null && base != null && base > promo ? base : undefined,
      available: inStock(stock.statusCode, stock.quantity),
      colorCode: colorCode != null ? String(colorCode) : undefined,
      sizeCode: sizeCode != null ? String(sizeCode) : undefined,
    };
  });

  // Selecting by colour+size displayCode. If a selector is given but doesn't
  // match, surface it (a silently-wrong size is exactly what we must not do).
  const wantsVariant = sel.colorDisplayCode != null || sel.sizeDisplayCode != null;
  const chosen = wantsVariant
    ? variants.find((v) => v.colorCode === sel.colorDisplayCode && v.sizeCode === sel.sizeDisplayCode)
    : undefined;
  if (wantsVariant && !chosen) {
    return {
      ok: false,
      kind: "parse",
      message: `uniqlo: selected colour ${sel.colorDisplayCode}/size ${sel.sizeDisplayCode} not in l2s (check the code)`,
      checkedAt,
    };
  }

  const price = chosen?.price ?? variants.find((v) => v.price != null)?.price;
  const available = chosen ? chosen.available : variants.some((v) => v.available);
  const currency =
    (chosen && prices[chosen.id]?.base?.currency?.code) ??
    Object.values(prices)[0]?.base?.currency?.code ??
    item.currency ?? "SGD";

  return { ok: true, price, currency, compareAtPrice: chosen?.compareAtPrice, available, variants, checkedAt };
}

/** @param {import("../types.mjs").Item} item */
export async function readUniqlo(item) {
  const checkedAt = new Date().toISOString();
  const code = item.variantSelector?.productCode;
  if (!code) return { ok: false, kind: "parse", message: "uniqlo item missing variantSelector.productCode", checkedAt };
  const r = await httpGet(API_URL(code), {
    headers: { accept: "application/json", referer: item.url, "x-fr-clientid": CLIENT_ID },
    timeoutMs: 25000,
  });
  if (!r.ok) {
    const kind = r.status === 403 ? "blocked" : r.error === "timeout" ? "timeout" : "http";
    return { ok: false, kind, status: r.status, message: `uniqlo api failed (${r.status || r.error}); VERIFY endpoint`, checkedAt };
  }
  let data;
  try {
    data = JSON.parse(r.body);
  } catch {
    return { ok: false, kind: "parse", message: "uniqlo api did not return JSON; VERIFY endpoint", checkedAt };
  }
  return parseUniqlo(data, item);
}
