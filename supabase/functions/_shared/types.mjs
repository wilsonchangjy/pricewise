// Shared type definitions (JSDoc only — no runtime code).
// Phase 0 is plain ESM JavaScript so it runs on the installed Node 20 with no
// build step. These typedefs give editor hints and document the shapes that the
// Phase 1 Deno/Supabase port will turn into real TypeScript interfaces.

/**
 * @typedef {"shopify"|"jsonld"|"uniqlo"|"inditex"|"zara"|"asos"|"mango"|"cos"|"stories"|"stradivarius"|"bershka"|"wix"} SiteAdapter
 */

/**
 * A single thing we watch. One row per (URL + chosen variant).
 * @typedef {Object} Item
 * @property {string}  id            Stable key, also the state.json key.
 * @property {string}  label         Human name used in Telegram messages.
 * @property {string}  url           Product URL (also the link in alerts).
 * @property {SiteAdapter} adapter   Which reader to use.
 * @property {string}  [currency]    Currency code (e.g. "SGD"); .js/.json omit it.
 * @property {string}  [variantId]   Chosen Shopify variant id to track.
 * @property {Object}  [variantSelector]  Adapter-specific selection (Uniqlo).
 * @property {number}  [targetPrice] Alert only at/below this price.
 * @property {number}  [intervalHours] Override the default check cadence.
 * @property {boolean} [enabled]     false = configured but skipped.
 * @property {string}  [notes]       Free text.
 */

/**
 * One parsed size/colour line.
 * @typedef {Object} VariantReading
 * @property {string}  id
 * @property {string}  label
 * @property {number}  [price]
 * @property {number}  [compareAtPrice]
 * @property {boolean} available
 * @property {string}  [colorCode]
 * @property {string}  [sizeCode]
 */

/**
 * A good reading of a product at a point in time.
 * @typedef {Object} Reading
 * @property {true}    ok
 * @property {number}  price          Headline (chosen variant, else min).
 * @property {string}  currency
 * @property {number}  [compareAtPrice]
 * @property {boolean} available      Chosen variant (else any) in stock.
 * @property {VariantReading[]} variants
 * @property {string}  checkedAt      ISO timestamp.
 */

/**
 * A failed read. `kind:"soft"` means parsed-but-failed-validation — the
 * dangerous case the eng review flagged (200 OK but wrong/stale data).
 * @typedef {Object} ReadError
 * @property {false}   ok
 * @property {"blocked"|"timeout"|"http"|"parse"|"soft"} kind
 * @property {number}  [status]
 * @property {string}  message
 * @property {string}  checkedAt
 */

/** @typedef {Reading|ReadError} ReadResult */

/**
 * Per-item persisted state (data/state.json, keyed by item.id).
 * @typedef {Object} ItemState
 * @property {Reading} [lastReading]
 * @property {number}  [lastAlertPrice]   Dedup: last price we alerted at.
 * @property {string}  [lastAlertStatus]  "in_stock" | "oos" | "low".
 * @property {number}  [lastVariantCount] Soft-failure shape check.
 * @property {number}  consecutiveFailures
 * @property {string}  [nextCheckAt]      ISO; skip until due.
 * @property {boolean} [failureNotified]  Sent the "couldn't read" notice.
 * @property {boolean} [softNotified]     Sent the parser-warning notice.
 */

/**
 * @typedef {Object} AlertEvent
 * @property {"baseline"|"price_drop"|"price_up"|"restock"|"oos"|"low_stock"|"target_hit"} kind
 * @property {"info"|"alert"} level
 * @property {string} text
 */

export {};
