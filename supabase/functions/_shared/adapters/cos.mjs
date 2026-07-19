// COS adapter (H&M group). COS's frontend (cos.com) is Forter-protected, BUT its
// backend API host (cos.efashioncloud.com) is directly fetchable — no unblocker.
// Verified 2026-07-03:
//
//   /en-sg/api/cloud-item-basic/elasticsearch/item_all_info?code=CODE&store_id=250&merchant_id=100000072
//     -> { code, data: { itemName, qty, arrivalNotice,
//            frontProperties:[{ valueName, frontCode, frontQty }],           // colours
//            skus:[{ skuCode, qty, price, markingPrice,
//                    skuProperties:[{propertyName:"color", frontCode}, {propertyName:"size", valueName}] }] } }
//
// Track a colour+size via variantSelector { code (colour frontCode), size }.
//
// ⚠️ STOCK CAVEAT (to confirm): item_all_info returned qty:0 for ALL colours and
// sizes with arrivalNotice:1 — this catalog endpoint likely does NOT carry live
// stock (a separate inventory call does). If confirmed, readCos must also fetch
// that call and we merge it. For now availability = sku.qty > 0; pass a stock map
// to parseCos() to override once we have the real endpoint.

import { httpGet } from "../fetcher.mjs";
import { localeFromUrl } from "../locale.mjs";

const API = (locale, code, storeId, merchantId) =>
  `https://cos.efashioncloud.com/${locale}/api/cloud-item-basic/elasticsearch/item_all_info` +
  `?code=${code}&store_id=${storeId}&merchant_id=${merchantId}`;

const propOf = (sku, name) => (sku.skuProperties ?? []).find((p) => p.propertyName === name);

/**
 * @param {any} resp   parsed item_all_info response
 * @param {import("../types.mjs").Item} item
 * @param {Record<string, number>} [stockBySku]  optional real-time qty by skuCode
 * @returns {import("../types.mjs").ReadResult}
 */
export function parseCos(resp, item, stockBySku) {
  const checkedAt = new Date().toISOString();
  const data = resp?.data;
  const sel = item.variantSelector ?? {};
  const code = String(sel.code ?? "");
  if (!data || !Array.isArray(data.skus)) {
    return { ok: false, kind: "parse", message: "cos: no data.skus (shape changed?)", checkedAt };
  }
  const skus = data.skus.filter((s) => propOf(s, "color")?.frontCode === code);
  if (!skus.length) {
    return { ok: false, kind: "parse", message: `cos: colour ${code} not found in skus`, checkedAt };
  }

  const variants = skus.map((s) => {
    const size = propOf(s, "size")?.valueName;
    const price = s.price != null ? Number(s.price) : undefined;
    const marking = s.markingPrice != null ? Number(s.markingPrice) : undefined;
    const qty = stockBySku ? stockBySku[s.skuCode] : Number(s.qty ?? 0);
    return {
      id: String(s.skuCode),
      label: String(size ?? s.skuCode),
      price,
      compareAtPrice: marking != null && price != null && marking > price ? marking : undefined,
      available: Number(qty ?? 0) > 0,
      sizeCode: size != null ? String(size) : undefined,
    };
  });

  const wants = sel.size != null;
  const chosen = wants ? variants.find((v) => v.sizeCode === String(sel.size)) : undefined;
  if (wants && !chosen) {
    return { ok: false, kind: "parse", message: `cos: size ${sel.size} not found for colour ${code}`, checkedAt };
  }

  const currency = item.currency ?? localeFromUrl(item.url).currency ?? "SGD";
  const price = chosen?.price ?? variants.find((v) => v.price != null)?.price;
  const available = chosen ? chosen.available : variants.some((v) => v.available);
  return { ok: true, price, currency, compareAtPrice: chosen?.compareAtPrice, available, variants, checkedAt };
}

/** @param {import("../types.mjs").Item} item */
export async function readCos(item) {
  const checkedAt = new Date().toISOString();
  const sel = item.variantSelector ?? {};
  const code = sel.code;
  if (!code) return { ok: false, kind: "parse", message: "cos item missing variantSelector.code", checkedAt };
  const locale = sel.locale ?? "en-sg";
  const storeId = sel.storeId ?? "250";
  const merchantId = sel.merchantId ?? "100000072";

  const r = await httpGet(API(locale, code, storeId, merchantId), { headers: { accept: "application/json" } });
  if (!r.ok) {
    const kind = r.status === 403 ? "blocked" : r.error === "timeout" ? "timeout" : "http";
    return { ok: false, kind, status: r.status, message: `cos api failed (${r.status || r.error})`, checkedAt };
  }
  let resp;
  try {
    resp = JSON.parse(r.body);
  } catch {
    return { ok: false, kind: "parse", message: "cos api did not return JSON", checkedAt };
  }
  return parseCos(resp, item);
}
