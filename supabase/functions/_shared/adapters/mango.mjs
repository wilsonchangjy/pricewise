// Mango adapter. Verified live 2026-07-03: Mango serves per-size stock + price
// from two FREE, direct JSON APIs (no unblocker needed) on online-orchestrator:
//
//   /v3/prices/products?channelId=shop&countryIso=SG&productId=27009215
//     -> { "07": { price, previousPrices:{originalShop}, discountRate, ... } }   (keyed by COLOUR)
//   /v3/stock/products?countryIso=SG&channelId=shop&productId=27009215
//     -> { colors: { "07": { sizes: { "20": {available}, ... } } } }             (keyed by COLOUR then size CODE)
//
// countryIso (hence currency) comes from the URL's locale, not a default. Track a
// size via variantSelector { productId, color, sizeCode } — Mango uses numeric
// size codes (19=XS, 20=S, 21=M, ...); optional sizeLabels maps them for alerts.

import { httpGet } from "../fetcher.mjs";
import { localeFromUrl } from "../locale.mjs";

const ORCH = "https://online-orchestrator.mango.com/v3";
const pricesUrl = (id, iso) => `${ORCH}/prices/products?channelId=shop&countryIso=${iso}&productId=${id}`;
const stockUrl = (id, iso) => `${ORCH}/stock/products?countryIso=${iso}&channelId=shop&productId=${id}`;

/**
 * @param {any} prices  parsed /prices response (keyed by colour)
 * @param {any} stock   parsed /stock response ({colors:{...}})
 * @param {import("../types.mjs").Item} item
 * @returns {import("../types.mjs").ReadResult}
 */
export function parseMango(prices, stock, item) {
  const checkedAt = new Date().toISOString();
  const sel = item.variantSelector ?? {};
  const color = String(sel.color ?? "");
  const cp = prices?.[color];
  const cs = stock?.colors?.[color]?.sizes;
  if (!cp || !cs) {
    return { ok: false, kind: "parse", message: `mango: colour ${color} missing from prices/stock (shape changed?)`, checkedAt };
  }

  const price = cp.price != null ? Number(cp.price) : undefined;
  const oldRaw = cp.previousPrices?.originalShop;
  const compareAtPrice = oldRaw != null && price != null && Number(oldRaw) > price ? Number(oldRaw) : undefined;
  const labels = sel.sizeLabels ?? {};

  const variants = Object.entries(cs).map(([code, s]) => ({
    id: String(code),
    label: labels[code] ?? String(code),
    price,
    compareAtPrice,
    available: s?.available === true,
    sizeCode: String(code),
  }));
  if (!variants.length) return { ok: false, kind: "parse", message: "mango: no sizes in stock data", checkedAt };

  const wants = sel.sizeCode != null;
  const chosen = wants ? variants.find((v) => v.sizeCode === String(sel.sizeCode)) : undefined;
  if (wants && !chosen) {
    return { ok: false, kind: "parse", message: `mango: size code ${sel.sizeCode} not in stock data`, checkedAt };
  }

  const currency = item.currency ?? localeFromUrl(item.url).currency ?? "";
  const available = chosen ? chosen.available : variants.some((v) => v.available);
  return { ok: true, price: chosen?.price ?? price, currency, compareAtPrice: chosen ? chosen.compareAtPrice : compareAtPrice, available, variants, checkedAt };
}

/** @param {import("../types.mjs").Item} item */
export async function readMango(item) {
  const checkedAt = new Date().toISOString();
  const sel = item.variantSelector ?? {};
  const id = sel.productId;
  if (!id) return { ok: false, kind: "parse", message: "mango item missing variantSelector.productId", checkedAt };
  const iso = sel.countryIso ?? localeFromUrl(item.url).country ?? "SG";

  const [pr, st] = await Promise.all([
    httpGet(pricesUrl(id, iso), { headers: { accept: "application/json" } }),
    httpGet(stockUrl(id, iso), { headers: { accept: "application/json" } }),
  ]);
  const bad = !pr.ok ? pr : !st.ok ? st : null;
  if (bad) {
    const kind = bad.status === 403 ? "blocked" : bad.error === "timeout" ? "timeout" : "http";
    return { ok: false, kind, status: bad.status, message: `mango api failed (${bad.status || bad.error})`, checkedAt };
  }
  let prices, stock;
  try {
    prices = JSON.parse(pr.body);
    stock = JSON.parse(st.body);
  } catch {
    return { ok: false, kind: "parse", message: "mango api did not return JSON", checkedAt };
  }
  return parseMango(prices, stock, item);
}
