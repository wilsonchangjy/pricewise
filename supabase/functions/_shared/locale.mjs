// Infer { country, currency } from a product URL's locale segment.
//
// Why: currency should follow the LINK, not a hardcoded default. A /sg/ URL is
// SGD; a Berlin shop's /de/ URL is EUR. This lets adapters (a) request the right
// store and (b) label prices correctly — so we never silently assume USD and
// leave the user to guess. If the URL has no locale hint, we return undefined and
// the caller falls back to the currency the RESPONSE reports (e.g. JSON-LD
// priceCurrency) or an explicit item.currency override.

const COUNTRY_CURRENCY = {
  SG: "SGD", US: "USD", GB: "GBP", UK: "GBP", JP: "JPY", AU: "AUD", NZ: "NZD",
  CA: "CAD", HK: "HKD", MY: "MYR", KR: "KRW", CN: "CNY", CH: "CHF", SE: "SEK",
  DK: "DKK", NO: "NOK", AE: "AED", TW: "TWD", TH: "THB", ID: "IDR", PH: "PHP",
  IN: "INR", DE: "EUR", FR: "EUR", ES: "EUR", IT: "EUR", NL: "EUR", IE: "EUR",
  AT: "EUR", BE: "EUR", PT: "EUR", FI: "EUR",
};

/**
 * @param {string} url
 * @returns {{ country?: string, currency?: string }}
 */
export function localeFromUrl(url) {
  const u = String(url || "");
  let country;
  let m;
  if ((m = u.match(/[?&](?:countryIso|country|store)=([A-Za-z]{2})\b/i))) country = m[1];
  else if ((m = u.match(/\/([a-z]{2})\/[a-z]{2}(?:[\/?#]|$)/i))) country = m[1]; // /sg/en/
  else if ((m = u.match(/^(?:https?:\/\/)?[^/]+\/([a-z]{2})(?:[\/?#]|$)/i))) country = m[1]; // /sg/
  country = country ? country.toUpperCase() : undefined;
  const currency = country ? COUNTRY_CURRENCY[country] : undefined;
  return { country, currency };
}
