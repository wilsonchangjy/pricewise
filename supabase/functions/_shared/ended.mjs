// When a listing is OVER — sold, or ended by the seller.
//
// Out of stock and ended are different facts. A sold-out size can come back, so
// we keep watching and say "back in stock" when it does. A one-off that SOLD is
// not coming back: the honest message is "it's gone, I've stopped", said once,
// and the watch ends. Before this existed, a sold eBay jacket read as in stock
// for 54 days and its watcher was never told.
//
// A seller will often relist the same thing under a NEW item number (eBay's
// Relist always issues one). We offer that relist with one tap rather than
// switching to it silently: eBay's own wording is "relisted this item or one
// like this", so it may be a similar item at a different price, and changing
// what someone is watching without asking is the kind of surprise a tracker
// must not spring.
//
// Pure except for the injected `read`, so both halves are unit-testable.

import { itemIdOf } from "./adapters/ebay.mjs";
import { fmt } from "./alerting.mjs";

/** A relist of a relist is rare; a chain longer than this is not worth paying to walk. */
export const MAX_RELIST_HOPS = 2;

/**
 * Follow a relist link to the listing someone could actually act on.
 *
 * Each hop is one adapter read, which on eBay spends the watcher's unblocker
 * credits — hence the hop cap and the loop guard.
 *
 * @param {string} url            the relist link from the ended listing's banner
 * @param {(url:string) => Promise<object>} read   an adapter read for that url
 * @returns {Promise<null | { url, itemId, live?, available?, price?, currency?, ended?, sold?, when?, unread? }>}
 */
export async function followRelist(url, read, { maxHops = MAX_RELIST_HOPS } = {}) {
  const seen = new Set();
  let current = url;
  let last = null;
  for (let hop = 0; current && hop < maxHops && !seen.has(current); hop++) {
    seen.add(current);
    let r = null;
    try { r = await read(current); } catch { r = null; }
    const itemId = itemIdOf(current);
    // Couldn't read it. Say there IS a relist, without claiming anything about it.
    if (!r?.ok) return { url: current, itemId, unread: true };
    if (!r.ended) {
      return { url: current, itemId, live: Boolean(r.available), available: Boolean(r.available), price: r.price, currency: r.currency };
    }
    last = { url: current, itemId, ended: true, sold: Boolean(r.ended.sold), when: r.ended.when ?? null };
    current = r.ended.relistUrl;
  }
  return last;
}

/**
 * The one message a watcher gets when their listing ends.
 *
 * @returns {{ text: string, keyboard?: object }}
 */
export function endedMessage({ title, url }, ended, relist) {
  const when = ended?.when ? ` on ${ended.when}` : "";
  const lines = [
    ended?.sold ? `🏁 SOLD: ${title}` : `🏁 LISTING ENDED: ${title}`,
    ended?.sold
      ? `This listing sold${when}. A one-off doesn't come back, so I've stopped watching it and taken it off your list.`
      : `The seller ended this listing${when}, so I've stopped watching it and taken it off your list.`,
    url,
  ];

  // callback_data is capped at 64 bytes, so the button carries only the item id;
  // the webhook rebuilds the canonical link and adds it like a pasted one.
  const button = (itemId) => ({ inline_keyboard: [[{ text: "👀 Track the relist", callback_data: `rl:_:${itemId}` }]] });
  let keyboard;

  if (relist?.ended) {
    lines.push("", `The seller did relist it, but that one has ${relist.sold ? "sold" : "ended"} too${relist.when ? ` (${relist.when})` : ""}.`);
  } else if (relist?.unread) {
    lines.push("", "The seller has relisted it. I couldn't read the new listing just now, so have a look before you decide:", relist.url);
    if (relist.itemId) keyboard = button(relist.itemId);
  } else if (relist) {
    const state = relist.live ? `${fmt(relist.price, relist.currency)}, available now` : "but it's out of stock right now";
    lines.push(
      "",
      relist.live ? `The seller relisted it: ${state}.` : `The seller relisted it, ${state}.`,
      relist.url,
      "eBay's wording is \"this item or one like this\", so check it's the same one before you commit.",
    );
    if (relist.itemId) keyboard = button(relist.itemId);
  }

  return { text: lines.join("\n"), ...(keyboard ? { keyboard } : {}) };
}
