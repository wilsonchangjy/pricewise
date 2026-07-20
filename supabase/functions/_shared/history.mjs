// Price-history presentation. Pure functions — the SQL side returns numbers,
// this decides what we're entitled to SAY about them.
//
// The governing rule: we only know what we observed. A competitor with a year of
// crawled history can write "lowest ever"; we cannot, and pretending otherwise
// would be the worst kind of bug — a confident claim a user would act on, spending
// real money. Everything here is phrased against OUR observation window, and the
// strong claims are gated behind MIN_OBSERVATION_DAYS.

const MIN_OBSERVATION_DAYS = 14; // below this we describe, we don't conclude
const BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

/** @param {number[]} values @returns {string} */
export function sparkline(values) {
  const nums = (values ?? []).filter((n) => typeof n === "number" && Number.isFinite(n));
  if (!nums.length) return "";
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  if (max === min) return BLOCKS[0].repeat(Math.min(nums.length, 24));
  return nums
    .slice(-24)
    .map((n) => BLOCKS[Math.min(BLOCKS.length - 1, Math.floor(((n - min) / (max - min)) * (BLOCKS.length - 1) + 0.5))])
    .join("");
}

const money = (n, cur) =>
  typeof n === "number" && Number.isFinite(n) ? `${cur ? cur + " " : ""}${Number(n).toFixed(2)}` : "?";

const daysAgo = (iso) => {
  const ms = Date.now() - new Date(iso).getTime();
  const d = Math.floor(ms / 86_400_000);
  return d <= 0 ? "today" : d === 1 ? "yesterday" : `${d} days ago`;
};

/**
 * The one line appended to a price-drop alert to turn a notification into a
 * decision. Returns "" when we haven't watched long enough to say anything true.
 *
 * @param {{currency:string, current_price:number, min_price:number, max_price:number,
 *          min_at:string, observations:number, observation_days:number, is_lowest:boolean}} s
 * @param {number} windowDays
 */
export function contextLine(s, windowDays = 90) {
  if (!s || s.observations < 2) return "";

  if (s.observation_days < MIN_OBSERVATION_DAYS) {
    // Too early for a superlative — say what we've got, plainly.
    return `(only been watching this ${s.observation_days === 0 ? "since today" : `${s.observation_days} days`})`;
  }

  const span = Math.min(windowDays, s.observation_days);
  if (s.is_lowest) return `📉 Lowest I've seen in ${span} days of watching.`;

  const low = Number(s.min_price);
  if (Number.isFinite(low) && low < Number(s.current_price)) {
    return `Still above its ${span}-day low of ${money(low, s.currency)} (${daysAgo(s.min_at)}).`;
  }
  return "";
}

/**
 * The /history reply.
 * @param {{title:string, url:string}} product
 * @param {object} s      price_stats row
 * @param {{checked_at:string, price:number}[]} points  price_history rows
 * @param {number} windowDays
 */
export function formatHistory(product, s, points, windowDays = 90) {
  if (!s || !s.observations) {
    return `I haven't recorded a price for ${product.title} yet — give it a check cycle.`;
  }
  const cur = s.currency;
  const prices = (points ?? []).map((p) => Number(p.price));
  const chart = sparkline(prices);

  const lines = [`📈 ${product.title}`, `Now: ${money(s.current_price, cur)}`];

  // Count REAL moves, not rows: early rows predate change-only writes, and
  // "3 price changes" on a price that never moved is exactly the kind of small
  // overstatement this feature exists to avoid.
  const changes = prices.reduce((n, p, i) => (i && p !== prices[i - 1] ? n + 1 : n), 0);
  if (chart && prices.length > 1) {
    lines.push(`${chart}  ${changes === 0 ? "(unchanged so far)" : `(${changes} price change${changes > 1 ? "s" : ""})`}`);
  }

  if (s.observation_days < MIN_OBSERVATION_DAYS) {
    lines.push(
      `I've only been watching this for ${s.observation_days === 0 ? "less than a day" : `${s.observation_days} days`}, ` +
        "so there's not much history to judge against yet.",
    );
  } else {
    const span = Math.min(windowDays, s.observation_days);
    lines.push(`Last ${span} days: low ${money(s.min_price, cur)} · high ${money(s.max_price, cur)}`);
    if (s.is_lowest) lines.push("📉 That's the lowest I've seen it.");
    else lines.push(`Cheapest was ${money(s.min_price, cur)}, ${daysAgo(s.min_at)}.`);
  }

  // Never let the number be mistaken for the product's actual all-time low.
  lines.push(`(Prices I've observed since I started watching, not the shop's own history.)`);
  lines.push(product.url);
  return lines.join("\n");
}

export { MIN_OBSERVATION_DAYS };
