// The alert state machine — the part that must not have bugs, because a wrong
// answer here is a missed sale or alert spam.
//
//  prev reading?            transition checked            dedup rule
//  ------------             ------------------            -----------------------
//  none      -> baseline (info only, no alert)        set lastAlertPrice/Status
//  in -> out -> "sold out"                            lastAlertStatus = oos
//  out -> in -> "back in stock"                       lastAlertStatus = in_stock
//  sizes low -> "running low" (best-effort)           lastAlertStatus = low
//  price<=target -> "target hit" (ALWAYS, no floor)   lastAlertPrice  = price
//  price<lastAlertPrice by >=5% and >=2 -> "price drop"  lastAlertPrice = price
//  price<lastAlertPrice by less        -> (no alert)  lastAlertPrice UNCHANGED
//  price>lastAlertPrice -> (raise baseline, no alert) lastAlertPrice  = price
//
// evaluate() is PURE: same inputs -> same events. No I/O. Heavily tested.

const LOW_STOCK_RATIO = 0.4; // <=40% of variants left = "running low"

// Stock states the shop told us about, as opposed to ratios we inferred.
const COMING_SOON = "coming_soon";
const LOW_STOCK = "low_stock";

// A price increase only alerts if it's meaningful. NOTE: PRICE_UP_ABS is in the
// item's own currency units, so it's naive across very different currencies
// (JPY 10 is tiny); fine for SGD/USD, revisit when we track e.g. JPY items.
const PRICE_UP_PCT = 10; // >= +10% ...
const PRICE_UP_ABS = 10; // ... OR >= +10 currency units, whichever hits first

// A price DROP has to be worth acting on. EUR 65.00 -> EUR 64.00 is a real drop
// and useless news: it fired an alert reading "(2% off)" for one euro.
//
// BOTH conditions must hold, i.e. the bar is max(5%, 2 units):
//   - the percentage carries cheap items, where 5% is pennies;
//   - the absolute floor carries expensive ones, where 5% is already plenty.
// A flat 5-unit floor was the obvious choice and is wrong: it would mute a
// 15.00 -> 12.00 tee (20% off) because 3.00 < 5.00, which is exactly the kind
// of deal someone tracks an item for.
const PRICE_DROP_PCT = 5;
const PRICE_DROP_ABS = 2;

/**
 * Is this drop worth a message? Compared against the last price we ALERTED at,
 * never the last price we saw — see the call site for why that distinction is
 * what makes a slow bleed still reach the user.
 */
export function isDropWorthAlerting(from, to) {
  if (!(from > 0) || !(to < from)) return false;
  const abs = from - to;
  return (abs / from) * 100 >= PRICE_DROP_PCT && abs >= PRICE_DROP_ABS;
}

/** @param {number|undefined} n @param {string} cur */
export function fmt(n, cur) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "?";
  return `${cur ? cur + " " : ""}${n.toFixed(2)}`;
}

/**
 * @param {import("./types.mjs").Item} item
 * @param {import("./types.mjs").ItemState} prev   Existing state (may be empty-ish).
 * @param {import("./types.mjs").Reading} reading
 * @returns {{ events: import("./types.mjs").AlertEvent[], patch: Partial<import("./types.mjs").ItemState> }}
 */
export function evaluate(item, prev, reading) {
  /** @type {import("./types.mjs").AlertEvent[]} */
  const events = [];
  /** @type {Partial<import("./types.mjs").ItemState>} */
  const patch = { lastVariantCount: reading.variants.length };

  const chosen = item.variantId
    ? reading.variants.find((v) => v.id === String(item.variantId))
    : undefined;
  const chosenState = chosen?.state;
  const price = chosen?.price ?? reading.price;
  const available = chosen ? chosen.available : reading.available;
  const total = reading.variants.length;
  const inStockCount = reading.variants.filter((v) => v.available).length;

  // --- First sighting: baseline only, never an "alert". ---
  if (!prev || !prev.lastReading) {
    const off =
      reading.compareAtPrice && price && reading.compareAtPrice > price
        ? Math.round((1 - price / reading.compareAtPrice) * 100)
        : 0;
    events.push({
      kind: "baseline",
      level: "info",
      text:
        `👀 Now watching ${item.label}\n` +
        `Right now: ${fmt(price, reading.currency)}` +
        (off ? ` (${off}% off retail)` : "") +
        (available ? "" : " — OUT OF STOCK") + "\n" +
        // Without this line a baseline reads like NEWS. A user who set a size hours
        // ago sees "OUT OF STOCK" arrive out of nowhere and reasonably asks "did it
        // come back and sell out again?" It didn't — this is just where we're starting.
        (available
          ? "That's the starting point, not a change — I'll only message again when something moves."
          : "That's the starting point, not a change — I'll message you the moment it's back."),
    });
    patch.lastAlertPrice = price;
    patch.lastAlertStatus = available ? "in_stock" : "oos";
    return { events, patch };
  }

  const prevStatus = prev.lastAlertStatus ?? (prev.lastReading.available ? "in_stock" : "oos");

  // --- Availability transitions ---
  // "coming" is a NOT-BUYABLE status, so it must count as a restock trigger too.
  // Missing this meant an item that announced its return and then arrived went
  // silent — losing the restock alert precisely for the items we'd promised it on.
  if (available && (prevStatus === "oos" || prevStatus === "coming")) {
    events.push({
      kind: "restock",
      level: "alert",
      text: `✅ BACK IN STOCK: ${item.label}\n${fmt(price, reading.currency)}\n${item.url}`,
    });
    patch.lastAlertStatus = "in_stock";
  } else if (!available && chosenState === COMING_SOON && prevStatus !== "coming") {
    // The earliest signal this product can give: announced, not yet orderable.
    // Worth its own message — "sold out" would be both wrong and discouraging.
    events.push({
      kind: "coming_soon",
      level: "alert",
      text: `🔜 COMING BACK: ${item.label}\nThe shop has it listed as coming soon — I'll tell you the moment it's buyable.\n${item.url}`,
    });
    patch.lastAlertStatus = "coming";
  } else if (!available && prevStatus !== "oos" && chosenState !== COMING_SOON) {
    events.push({
      kind: "oos",
      level: "alert",
      text: `⛔ SOLD OUT: ${item.label}\n${item.url}`,
    });
    patch.lastAlertStatus = "oos";
  } else if (available && chosenState === LOW_STOCK && prevStatus !== "low") {
    // The shop itself says this size is nearly gone — far better evidence than
    // our ratio heuristic, which only sees how many OTHER sizes are left.
    events.push({
      kind: "low_stock",
      level: "alert",
      text: `⚠️ NEARLY GONE: ${item.label}\nThe shop lists your size as low stock.\n${item.url}`,
    });
    patch.lastAlertStatus = "low";
  } else if (available && total > 0) {
    // --- Low stock (best-effort): still buyable, but sizes are selling through ---
    const ratio = inStockCount / total;
    if (ratio > 0 && ratio <= LOW_STOCK_RATIO && prevStatus !== "low") {
      events.push({
        kind: "low_stock",
        level: "alert",
        text: `⚠️ RUNNING LOW: ${item.label}\nOnly ${inStockCount}/${total} variants left\n${item.url}`,
      });
      patch.lastAlertStatus = "low";
    }
  }

  // --- Price ---
  const lastAlertPrice = prev.lastAlertPrice ?? prev.lastReading.price;
  if (typeof price === "number" && typeof lastAlertPrice === "number") {
    if (item.targetPrice != null && price <= item.targetPrice && price < lastAlertPrice) {
      events.push({
        kind: "target_hit",
        level: "alert",
        text: `🎯 TARGET HIT: ${item.label}\n${fmt(price, reading.currency)} (<= your ${fmt(item.targetPrice, reading.currency)})\n${item.url}`,
      });
      patch.lastAlertPrice = price;
    } else if (price < lastAlertPrice) {
      if (isDropWorthAlerting(lastAlertPrice, price)) {
        const off = Math.round((1 - price / lastAlertPrice) * 100);
        events.push({
          kind: "price_drop",
          level: "alert",
          text: `💸 PRICE DROP: ${item.label}\n${fmt(lastAlertPrice, reading.currency)} -> ${fmt(price, reading.currency)} (${off}% off)\n${item.url}`,
        });
        patch.lastAlertPrice = price;
      }
      // Too small to shout about — and CRUCIALLY we leave lastAlertPrice alone.
      // Banking the new number would reset the yardstick every time, so 65 -> 64
      // -> 63 -> 62 would slide all the way down in silent one-unit steps. Held
      // at 65, the same slide alerts the moment it reaches 61.75, and the
      // message honestly reads "65.00 -> 61.75" rather than "62.00 -> 61.75".
    } else if (price > lastAlertPrice) {
      // Price went up. Only shout if the jump is SIGNIFICANT (a "buy before it
      // climbs further" signal); small bumps just raise the baseline silently.
      const upAbs = price - lastAlertPrice;
      const upPct = Math.round((upAbs / lastAlertPrice) * 100);
      if (upPct >= PRICE_UP_PCT || upAbs >= PRICE_UP_ABS) {
        events.push({
          kind: "price_up",
          level: "alert",
          text: `📈 PRICE UP: ${item.label}\n${fmt(lastAlertPrice, reading.currency)} -> ${fmt(price, reading.currency)} (+${upPct}%)\n${item.url}`,
        });
      }
      patch.lastAlertPrice = price; // raise the baseline either way
    }
    // price === lastAlertPrice -> flat, no alert, no change (kills repeat spam).
  }

  return { events, patch };
}
