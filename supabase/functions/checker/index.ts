// The checker — invoked by pg_cron every few minutes.
//
// Claims the products whose clock is due (FOR UPDATE SKIP LOCKED, so overlapping
// ticks never double-fetch), reads each one ONCE through its adapter, then fans
// the diff out to every subscriber. Defended products are fetched with the
// subscriber's own unblocker key.

// @ts-nocheck  (the _shared modules are plain ESM/JSDoc, shared with the Node tests)
import { createClient } from "jsr:@supabase/supabase-js@2";
import { selectAdapter } from "../_shared/adapters/index.mjs";
import { evaluate } from "../_shared/alerting.mjs";
import { sendMessage, isUnreachable } from "../_shared/telegram.mjs";
import { contextLine } from "../_shared/history.mjs";
import { matchVariant } from "../_shared/variants.mjs";
import { verifyPrice } from "../_shared/verify.mjs";

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const BATCH_SIZE = Number(Deno.env.get("CHECK_BATCH_SIZE") ?? 20);
const MAX_FAILURES = 10; // then the product is parked as dead
const NOTIFY_AFTER = 3;  // ...and we warn the watchers at this point
const VERIFY_SAMPLE_DAYS = 7;   // sanity-check even when nothing looks wrong
const VERIFY_DEFENDED_MIN_H = 24; // defended checks spend the USER's credits
const TIER_MEMORY_DAYS = 7;       // then re-probe from plain in case a site relaxed

const db = createClient(
  Deno.env.get("SUPABASE_URL"),
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false } },
);

Deno.serve(async () => {
  const { data: due, error } = await db.rpc("claim_due_products", { batch_size: BATCH_SIZE });
  if (error) {
    console.error("claim_due_products failed:", error);
    return json({ ok: false, error: error.message }, 500);
  }

  const summary = { claimed: due?.length ?? 0, checked: 0, failed: 0, alerts: 0 };
  for (const product of due ?? []) {
    try {
      const r = await checkProduct(product);
      r.ok ? summary.checked++ : summary.failed++;
      summary.alerts += r.alerts ?? 0;
    } catch (e) {
      summary.failed++;
      console.error(`product ${product.id} threw:`, e);
      await recordFailure(product, String(e?.message ?? e));
    }
  }
  console.log("checker run:", JSON.stringify(summary));
  return json(summary);
});

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function checkProduct(product) {
  const { data: rows } = await db
    .from("subscriptions")
    .select("*, users(telegram_chat_id, is_allowed)")
    .eq("product_id", product.id)
    .eq("status", "active");

  // Revoking access (is_allowed=false) has to STOP the work, not just block new
  // commands — otherwise a banned user's list keeps costing fetches and alerts.
  const subs = (rows ?? []).filter((s) => s.users?.is_allowed);

  // Nobody is listening (all paused/removed/revoked) — don't spend a fetch on it.
  if (!subs.length) {
    await db.from("tracked_products")
      .update({ next_check_at: minutesFromNow(24 * 60) })
      .eq("id", product.id);
    return { ok: true, alerts: 0 };
  }

  let unblockerKey, unblockerProvider;
  if (product.fetch_strategy === "unblocker") {
    const { data } = await db.rpc("get_unblocker_for_product", { p_product_id: product.id });
    const row = Array.isArray(data) ? data[0] : data;
    unblockerKey = row?.api_key ?? undefined;
    unblockerProvider = row?.provider ?? undefined;
  }

  const item = {
    id: String(product.id),
    label: product.title,
    url: product.url,
    adapter: product.adapter,
    variantSelector: product.variant_selector ?? {},
  };

  // Start at the tier we know works for this site, so we stop paying to
  // rediscover it. Forget weekly: a site that relaxes should get cheap again
  // rather than being billed at yesterday's difficulty forever.
  const tierAge = product.unblocker_tier_at
    ? (Date.now() - new Date(product.unblocker_tier_at).getTime()) / 86_400_000
    : Infinity;
  const startTier = tierAge < TIER_MEMORY_DAYS ? (product.unblocker_tier ?? undefined) : undefined;

  const reading = await selectAdapter(product.adapter)(item, { unblockerKey, unblockerProvider, startTier });

  if (!reading.ok) {
    await recordFailure(product, reading.message, reading.kind, subs);
    return { ok: false, alerts: 0 };
  }

  // Previous reading = the baseline for the diff (before we insert this one).
  const { data: prevRows } = await db
    .from("product_readings")
    .select("*")
    .eq("product_id", product.id)
    .order("checked_at", { ascending: false })
    .limit(1);
  const prevReading = prevRows?.[0] ? rowToReading(prevRows[0]) : null;

  // Only record a reading when something actually CHANGED. Most checks return
  // an identical answer, and product_readings carries the fat variants blob —
  // writing one every few hours per item is what fills the database. "When did
  // we last check?" lives on tracked_products.last_ok_at instead, so nothing is
  // lost: the newest row is still the last DISTINCT state, which is exactly what
  // the diff compares against.
  if (!prevReading || readingChanged(prevReading, reading, prevRows?.[0])) {
    await db.from("product_readings").insert({
      product_id: product.id,
      price: reading.price ?? null,
      compare_at_price: reading.compareAtPrice ?? null,
      currency: reading.currency ?? null,
      available: reading.available ?? null,
      variants: reading.variants ?? [],
      raw_status: reading.available ? "ok" : "oos", // may be rewritten to 'soft' below
    });
  }

  // Verify BEFORE we make a price claim. Cost lands on alerts, not on checks:
  // a price that hasn't moved needs no second opinion, and a wrong number only
  // does damage at the moment we tell someone to act on it.
  const priceMoved = prevReading
    && typeof reading.price === "number" && typeof prevReading.price === "number"
    && reading.price !== prevReading.price;
  const verdict = await maybeVerify(product, reading, priceMoved);
  const priceTrusted = verdict?.status !== "disagree";

  let alerts = 0;
  for (const sub of subs) {
    alerts += await alertSubscriber(sub, product, prevReading, reading, priceTrusted);
  }

  await db.from("tracked_products").update({
    last_ok_at: new Date().toISOString(),
    consecutive_failures: 0,
    status: "active",
    next_check_at: minutesFromNow(product.check_interval_minutes),
    ...(reading.tier && reading.tier !== product.unblocker_tier
      ? { unblocker_tier: reading.tier, unblocker_tier_at: new Date().toISOString() }
      : reading.tier
      ? { unblocker_tier_at: new Date().toISOString() }
      : {}),
  }).eq("id", product.id);

  return { ok: true, alerts };
}

async function alertSubscriber(sub, product, prevReading, reading, priceTrusted = true) {
  // A saved default size ("shoes: UK9") parked at /add — now we finally know what
  // this shop calls its sizes, so resolve it against the REAL labels. A default
  // that doesn't match is dropped, never approximated: watching the wrong size is
  // indistinguishable from working right up until the restock they miss.
  if (sub.pending_size && !sub.variant_id) {
    const hit = matchVariant(reading.variants, sub.pending_size);
    if (hit) {
      await db.from("subscriptions")
        .update({ variant_id: String(hit.id), variant_label: hit.label, pending_size: null })
        .eq("id", sub.id);
      sub.variant_id = String(hit.id);
      sub.variant_label = hit.label;
      sub.appliedDefault = sub.pending_size;
    } else {
      await db.from("subscriptions").update({ pending_size: null }).eq("id", sub.id);
      sub.unmatchedDefault = sub.pending_size;
    }
    sub.pending_size = null;
  }

  const item = {
    id: String(product.id),
    label: sub.variant_label ? `${product.title} — ${sub.variant_label}` : product.title,
    url: product.url,
    variantId: sub.variant_id ?? undefined,
    targetPrice: sub.target_price != null ? Number(sub.target_price) : undefined,
  };

  // A subscriber who has never been baselined gets the "now watching" message,
  // even when the product itself already has history (someone else added it).
  const baselined = sub.last_alert_status != null;
  const prev = baselined
    ? {
        lastReading: prevReading ?? reading,
        lastAlertPrice: sub.last_alert_price != null ? Number(sub.last_alert_price) : undefined,
        lastAlertStatus: sub.last_alert_status,
      }
    : null;

  let { events, patch } = evaluate(item, prev, reading);

  // A disputed price must not become a "PRICE DROP" someone spends money on.
  // Stock events survive: availability comes from a different data path, and
  // "your size is back" is still true whatever the price disagreement.
  if (!priceTrusted) {
    events = events.filter((e) => e.kind !== "price_drop" && e.kind !== "target_hit" && e.kind !== "price_up");
    delete patch.lastAlertPrice; // don't bank a number we don't believe
  }

  // A drop alert asks a silent question: "is this actually a good price?" We can
  // answer it from our own observations — carefully, since our history starts the
  // day we first saw the item, not the day it went on sale.
  if (events.some((e) => e.kind === "price_drop" || e.kind === "target_hit")) {
    const { data: stats } = await db.rpc("price_stats", { p_product_id: product.id, p_days: 90 });
    const line = contextLine(Array.isArray(stats) ? stats[0] : stats, 90);
    if (line) {
      for (const e of events) {
        if (e.kind === "price_drop" || e.kind === "target_hit") e.text += `\n${line}`;
      }
    }
  }

  // Whatever we decided about their default size, say so on the first message —
  // an unannounced choice is one they can't correct.
  if (sub.appliedDefault) {
    for (const e of events) {
      if (e.kind === "baseline") e.text += `\n(Using your saved size ${sub.appliedDefault} — /size to change.)`;
    }
  } else if (sub.unmatchedDefault) {
    for (const e of events) {
      if (e.kind === "baseline") {
        e.text += `\n(Your saved size ${sub.unmatchedDefault} isn't offered here, so I'm watching every size. /size to pick one.)`;
      }
    }
  }

  const wanted = sub.alert_on ?? {};
  let sent = 0;
  let delivered = true;
  for (const ev of events) {
    if (ev.kind !== "baseline" && wanted[ev.kind] === false) continue;
    const res = await sendMessage(BOT_TOKEN, sub.users.telegram_chat_id, ev.text, { preview: true });
    if (isUnreachable(res)) {
      // They blocked the bot or the chat is gone. Retrying is pointless and, with
      // delivery-gated state, endless — so park the subscription. /resume revives it.
      console.warn(`subscription ${sub.id}: chat unreachable (${res.description ?? res.error_code}) — pausing`);
      await db.from("subscriptions").update({ status: "paused" }).eq("id", sub.id);
      return sent;
    }
    if (!res?.ok) { delivered = false; continue; } // transient — retry on the next tick
    await db.from("alerts").insert({ subscription_id: sub.id, kind: ev.kind, payload: { text: ev.text } });
    sent++;
  }

  // Advancing the dedup state on an UNDELIVERED alert loses it forever: the next
  // check sees no transition and stays quiet. So only move it once Telegram took it.
  if (!delivered) return sent;

  const update = {};
  if ("lastAlertPrice" in patch) update.last_alert_price = patch.lastAlertPrice ?? null;
  if ("lastAlertStatus" in patch) update.last_alert_status = patch.lastAlertStatus;
  if (Object.keys(update).length) await db.from("subscriptions").update(update).eq("id", sub.id);

  return sent;
}

/**
 * Did anything worth storing change? Compares the headline numbers plus the
 * per-size availability signature — a size selling out matters even when the
 * price and "is anything in stock" answer both stay put.
 */
function readingChanged(prev, next, prevRow) {
  if (prev.price !== next.price) return true;
  if (prev.compareAtPrice !== next.compareAtPrice) return true;
  if (prev.currency !== next.currency) return true;
  if (prev.available !== next.available) return true;
  // Old rows may have had their variants compacted away by the retention job;
  // with nothing to compare, the scalars above are the whole story.
  const compacted = !prevRow?.variants || (Array.isArray(prevRow.variants) && prevRow.variants.length === 0);
  if (compacted) return false;
  return sig(prev.variants) !== sig(next.variants);
}

const sig = (variants) =>
  (variants ?? [])
    .map((v) => `${v.id}:${v.available ? 1 : 0}:${v.state ?? ""}:${v.price ?? ""}`)
    .sort()
    .join("|");

/**
 * Decide whether this reading earns a second opinion, and record the outcome.
 * Verify when the price MOVED (a claim is imminent) or when the weekly sample is
 * due (an adapter can be quietly wrong for weeks without crossing a threshold).
 */
async function maybeVerify(product, reading, priceMoved) {
  const lastAt = product.last_verified_at ? new Date(product.last_verified_at).getTime() : 0;
  const ageH = (Date.now() - lastAt) / 3_600_000;

  // Defended products cost the user's own unblocker credits, so they're verified
  // at most daily and never merely for the sample.
  const defended = product.fetch_strategy === "unblocker";
  const sampleDue = !defended && ageH >= VERIFY_SAMPLE_DAYS * 24;
  if (defended && (!priceMoved || ageH < VERIFY_DEFENDED_MIN_H)) return null;
  if (!priceMoved && !sampleDue) return null;

  const verdict = await verifyPrice(product, reading);

  // "unknown" is not evidence of anything — don't let an unreachable second
  // source mark a good adapter as broken, and don't reset the sample clock.
  if (verdict.status === "unknown") {
    console.warn(`verify ${product.id}: unknown (${verdict.reason})`);
    return verdict;
  }

  await db.from("tracked_products").update({
    last_verified_at: new Date().toISOString(),
    verify_note: verdict.status === "disagree" ? verdict.reason : null,
  }).eq("id", product.id);

  if (verdict.status === "disagree") {
    console.error(`verify ${product.id} DISAGREE: ${verdict.reason} — withholding price claims`);
  }
  return verdict;
}

/** product_readings row -> the Reading shape alerting.mjs expects. */
function rowToReading(row) {
  return {
    ok: true,
    price: row.price != null ? Number(row.price) : undefined,
    compareAtPrice: row.compare_at_price != null ? Number(row.compare_at_price) : undefined,
    currency: row.currency ?? undefined,
    available: row.available ?? false,
    variants: Array.isArray(row.variants) ? row.variants : [],
    checkedAt: row.checked_at,
  };
}

/** Exponential back-off; a persistently broken URL is parked, not retried forever. */
async function recordFailure(product, message, kind = "error", subs = null) {
  const failures = (product.consecutive_failures ?? 0) + 1;
  const backoff = product.check_interval_minutes * Math.min(2 ** failures, 8);
  console.warn(`product ${product.id} (${product.adapter}) failed x${failures}: ${message}`);

  // Silence is the one thing a watcher must never do. Speak up once when we start
  // backing off, and once more when we give up — the equality checks keep it to
  // exactly two messages per broken item.
  if (failures === NOTIFY_AFTER || failures === MAX_FAILURES) {
    const watchers = subs ?? (await db.from("subscriptions")
      .select("*, users(telegram_chat_id)").eq("product_id", product.id).eq("status", "active")).data ?? [];
    const text = failures >= MAX_FAILURES
      ? `❌ I've given up on ${product.title}\nIt failed ${failures} checks in a row (${message}).\nIt's off your check list — send the link again if you think it's fixed.\n${product.url}`
      : `⚠️ I'm having trouble reading ${product.title}\n${message}\nI'll keep trying, less often. If it never recovers I'll tell you.\n${product.url}`;
    for (const w of watchers) await sendMessage(BOT_TOKEN, w.users.telegram_chat_id, text);
  }

  await db.from("product_readings").insert({
    product_id: product.id,
    raw_status: kind === "blocked" ? "blocked" : kind === "soft" ? "soft" : "error",
  });
  await db.from("tracked_products").update({
    unblocker_tier: null, // it stopped working; re-explore from plain next time
    consecutive_failures: failures,
    status: failures >= MAX_FAILURES ? "dead" : failures >= 3 ? "backing_off" : "active",
    next_check_at: minutesFromNow(backoff),
  }).eq("id", product.id);
}

const minutesFromNow = (min) => new Date(Date.now() + min * 60_000).toISOString();
