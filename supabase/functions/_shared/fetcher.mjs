// Thin HTTP GET with a browser-ish User-Agent and a hard timeout.
// Phase 0 does DIRECT fetches only. Phase 1 adds the unblocker fallback here
// (on a 403, re-request through the unblocker API and return rendered HTML).

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

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
    const res = await fetch(url, {
      headers: {
        "user-agent": UA,
        "accept-language": "en-SG,en;q=0.9",
        accept: "*/*",
        ...headers,
      },
      redirect: "follow",
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
