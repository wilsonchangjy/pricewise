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
import { sendMessage } from "../_shared/telegram.mjs";

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const BATCH_SIZE = Number(Deno.env.get("CHECK_BATCH_SIZE") ?? 20);
const MAX_FAILURES = 10; // then the product is parked as dead
const NOTIFY_AFTER = 3;  // ...and we warn the watchers at this point

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
  const { data: subs } = await db
    .from("subscriptions")
    .select("*, users(telegram_chat_id)")
    .eq("product_id", product.id)
    .eq("status", "active");

  // Nobody is listening (all paused/removed) — don't spend a fetch on it.
  if (!subs?.length) {
    await db.from("tracked_products")
      .update({ next_check_at: minutesFromNow(24 * 60) })
      .eq("id", product.id);
    return { ok: true, alerts: 0 };
  }

  let unblockerKey;
  if (product.fetch_strategy === "unblocker") {
    const { data } = await db.rpc("get_unblocker_key_for_product", { p_product_id: product.id });
    unblockerKey = data ?? undefined;
  }

  const item = {
    id: String(product.id),
    label: product.title,
    url: product.url,
    adapter: product.adapter,
    variantSelector: product.variant_selector ?? {},
  };
  const reading = await selectAdapter(product.adapter)(item, { unblockerKey });

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

  await db.from("product_readings").insert({
    product_id: product.id,
    price: reading.price ?? null,
    compare_at_price: reading.compareAtPrice ?? null,
    currency: reading.currency ?? null,
    available: reading.available ?? null,
    variants: reading.variants ?? [],
    raw_status: reading.available ? "ok" : "oos",
  });

  let alerts = 0;
  for (const sub of subs) {
    alerts += await alertSubscriber(sub, product, prevReading, reading);
  }

  await db.from("tracked_products").update({
    last_ok_at: new Date().toISOString(),
    consecutive_failures: 0,
    status: "active",
    next_check_at: minutesFromNow(product.check_interval_minutes),
  }).eq("id", product.id);

  return { ok: true, alerts };
}

async function alertSubscriber(sub, product, prevReading, reading) {
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

  const { events, patch } = evaluate(item, prev, reading);

  const wanted = sub.alert_on ?? {};
  let sent = 0;
  let delivered = true;
  for (const ev of events) {
    if (ev.kind !== "baseline" && wanted[ev.kind] === false) continue;
    const res = await sendMessage(BOT_TOKEN, sub.users.telegram_chat_id, ev.text);
    if (!res?.ok) { delivered = false; continue; } // retry on the next tick
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
    consecutive_failures: failures,
    status: failures >= MAX_FAILURES ? "dead" : failures >= 3 ? "backing_off" : "active",
    next_check_at: minutesFromNow(backoff),
  }).eq("id", product.id);
}

const minutesFromNow = (min) => new Date(Date.now() + min * 60_000).toISOString();
