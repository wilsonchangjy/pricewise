// Adapter dispatch. Every reader has the signature read(item, ctx) where
// ctx = { unblockerKey } — free adapters simply ignore ctx.

import { readShopify } from "./shopify.mjs";
import { readUniqlo } from "./uniqlo.mjs";
import { readMango } from "./mango.mjs";
import { readCos } from "./cos.mjs";
import { readStories } from "./stories.mjs";
import { readInditex } from "./inditex.mjs";
import { readZara } from "./zara.mjs";
import { readAsos } from "./asos.mjs";
import { readStradivarius } from "./stradivarius.mjs";
import { readBershka } from "./bershka.mjs";
import { readWix } from "./wix.mjs";
import { readAmazon } from "./amazon.mjs";
import { readFarfetch } from "./farfetch.mjs";
import { readMrPorter } from "./mrporter.mjs";
import { readEbay } from "./ebay.mjs";
import { readJsonLd } from "./jsonld.mjs";

const READERS = {
  shopify: readShopify,
  uniqlo: readUniqlo,
  mango: readMango,
  cos: readCos,
  stories: readStories,
  inditex: readInditex,
  zara: readZara,
  asos: readAsos,
  stradivarius: readStradivarius,
  bershka: readBershka,
  wix: readWix,
  amazon: readAmazon,
  farfetch: readFarfetch,
  mrporter: readMrPorter,
  ebay: readEbay,
  jsonld: readJsonLd,
};

export const SUPPORTED_ADAPTERS = Object.keys(READERS);

/**
 * @param {string} adapter
 * @returns {(item:object, ctx?:{unblockerKey?:string}) => Promise<object>}
 */
export function selectAdapter(adapter) {
  return READERS[adapter] ?? readJsonLd;
}
