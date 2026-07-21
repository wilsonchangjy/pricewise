// Product titles come out of HTML, so they arrive with entities in them:
// "Men&#39;s Short Sleeve", "Levi&amp;#39;s", "Coat &ndash; Navy". Those go
// straight into Telegram messages, where they read as broken software.
//
// Deliberately a small named+numeric decoder rather than a DOM parse: Deno Edge
// Functions have no DOM, and this runs on every title we display.

const NAMED = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘",
  ldquo: "“", rdquo: "”", eacute: "é", egrave: "è", agrave: "à",
  ccedil: "ç", uuml: "ü", ouml: "ö", auml: "ä", szlig: "ß", deg: "°",
  reg: "®", copy: "©", trade: "™", euro: "€", pound: "£", yen: "¥",
};

/** @param {string} s */
export function decodeEntities(s) {
  if (!s) return s;
  let out = String(s);
  // Numeric first: &amp;#39; appears in the wild (double-encoded), so decoding
  // named entities first would leave a stray &#39; behind.
  out = out.replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeChar(parseInt(hex, 16)));
  out = out.replace(/&#(\d+);/g, (_, dec) => safeChar(parseInt(dec, 10)));
  out = out.replace(/&([a-z][a-z0-9]{1,10});/gi, (m, name) => NAMED[name.toLowerCase()] ?? m);
  // One more numeric pass catches the double-encoded case.
  out = out.replace(/&#(\d+);/g, (_, dec) => safeChar(parseInt(dec, 10)));
  return out;
}

function safeChar(code) {
  if (!Number.isFinite(code) || code < 9 || code > 0x10ffff) return "";
  try { return String.fromCodePoint(code); } catch { return ""; }
}
