// Thin HTTP GET with a browser-ish User-Agent, a hard timeout, and — the part
// that matters once strangers can submit URLs — a guard on EVERY redirect hop.
//
// Checking only the URL the user sent is not enough: a perfectly public link can
// answer 302 with Location: http://169.254.169.254/. So redirects are followed
// manually and each target is re-checked before we go anywhere near it.

import { assertSafeUrl } from "./urlguard.mjs";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

/**
 * fetch() with per-hop SSRF checking. Same return type as fetch().
 * @param {string} url
 * @param {RequestInit} [init]
 * @param {{ maxRedirects?: number, fetchImpl?: typeof fetch }} [opts]
 */
export async function safeFetch(url, init = {}, { maxRedirects = MAX_REDIRECTS, fetchImpl = fetch } = {}) {
  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const guard = assertSafeUrl(current);
    if (!guard.ok) throw new Error(`blocked ${hop ? "redirect " : ""}target: ${guard.reason}`);

    const res = await fetchImpl(current, { ...init, redirect: "manual" });
    if (!REDIRECT_CODES.has(res.status)) return res;

    const location = res.headers?.get?.("location");
    if (!location) return res; // a 3xx with nowhere to go — hand it back as-is
    current = new URL(location, current).toString(); // Location may be relative
  }
  throw new Error("too many redirects");
}

/**
 * @param {string} url
 * @param {{ timeoutMs?: number, headers?: Record<string,string> }} [opts]
 * @returns {Promise<{ status:number, ok:boolean, body:string, url?:string, error?:string }>}
 */
export async function httpGet(url, opts = {}) {
  const { timeoutMs = 20000, headers = {} } = opts;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await safeFetch(url, {
      headers: {
        "user-agent": UA,
        "accept-language": "en-SG,en;q=0.9",
        accept: "*/*",
        ...headers,
      },
      signal: ctrl.signal,
    });
    const body = await res.text();
    return { status: res.status, ok: res.ok, body, url: res.url };
  } catch (e) {
    const error = e && e.name === "AbortError" ? "timeout" : String(e?.message ?? e);
    return { status: 0, ok: false, body: "", error };
  } finally {
    clearTimeout(timer);
  }
}
