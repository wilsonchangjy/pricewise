// Telegram webhook — turns chat messages into rows.
//
// Telegram retries anything that isn't a 2xx, so this ALWAYS returns 200 once
// the shared-secret header checks out; errors are reported to the user in-chat
// instead of by status code.

// @ts-nocheck  (the _shared modules are plain ESM/JSDoc, shared with the Node tests)
import { createClient } from "jsr:@supabase/supabase-js@2";
import { parseCommand } from "../_shared/commands.mjs";
import { planAdd, MAX_DEFENDED } from "../_shared/policy.mjs";
import { detectAdapter } from "../_shared/router.mjs";
import { sendMessage, deleteMessage } from "../_shared/telegram.mjs";
import { labelFromUrl } from "../_shared/label.mjs";
import { resolveSelector, resolveFromPage, fetchTitle } from "../_shared/resolve.mjs";

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const WEBHOOK_SECRET = Deno.env.get("TELEGRAM_WEBHOOK_SECRET") ?? "";
const ALLOWED = new Set(
  (Deno.env.get("ALLOWED_TELEGRAM_IDS") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
);

const db = createClient(
  Deno.env.get("SUPABASE_URL"),
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false } },
);

const HELP = [
  "🛍️ Pricewise — I watch your items and ping you when your size restocks or the price drops.",
  "",
  "Paste a product link to start tracking it.",
  "",
  "/list — your tracked items",
  "/remove <n> — stop tracking one",
  "/setprice <n> <price> — only alert me at/below this",
  "/pause <n> · /resume <n> — mute / unmute",
  "/setkey <key> — your own ScrapingBee key for bot-protected stores",
  "/help — this message",
].join("\n");

Deno.serve(async (req) => {
  if (WEBHOOK_SECRET && req.headers.get("x-telegram-bot-api-secret-token") !== WEBHOOK_SECRET) {
    return new Response("forbidden", { status: 403 });
  }

  const update = await req.json().catch(() => null);
  const msg = update?.message ?? update?.edited_message;
  const chatId = msg?.chat?.id;
  const fromId = msg?.from?.id;
  if (!chatId || !fromId || typeof msg.text !== "string") return ok();

  try {
    await handle(msg, chatId, fromId);
  } catch (e) {
    console.error("handler error:", e);
    await sendMessage(BOT_TOKEN, chatId, "Something went wrong on my end — try again in a moment.");
  }
  return ok();
});

const ok = () => new Response("ok", { status: 200 });
const reply = (chatId, text) => sendMessage(BOT_TOKEN, chatId, text);

async function handle(msg, chatId, fromId) {
  const intent = parseCommand(msg.text);

  // A key must never linger in the chat history — scrub it before anything else.
  if (intent.redactMessage) await deleteMessage(BOT_TOKEN, chatId, msg.message_id);

  const user = await upsertUser(fromId, chatId);
  if (!user.is_allowed && !ALLOWED.has(String(fromId))) {
    return reply(chatId, `Pricewise is invite-only right now. Your Telegram ID is ${fromId} — ask the owner to add you.`);
  }

  // Parser-level usage errors ("Which one?", "Usage: …").
  if (intent.message && intent.cmd !== "unknown") return reply(chatId, intent.message);

  switch (intent.cmd) {
    case "help":    return reply(chatId, HELP);
    case "add":     return addItem(user, chatId, intent.url);
    case "list":    return listItems(user, chatId);
    case "remove":  return mutate(user, chatId, intent.ref, "remove");
    case "pause":   return mutate(user, chatId, intent.ref, "pause");
    case "resume":  return mutate(user, chatId, intent.ref, "resume");
    case "setprice":return mutate(user, chatId, intent.ref, "setprice", intent.price);
    case "setkey":  return setKey(user, chatId, intent.key);
    default:        return reply(chatId, intent.message ?? "Unknown command. Try /help.");
  }
}

async function upsertUser(telegramUserId, chatId) {
  const { data } = await db.from("users").select("*").eq("telegram_user_id", telegramUserId).maybeSingle();
  if (data) {
    if (Number(data.telegram_chat_id) !== Number(chatId)) {
      await db.from("users").update({ telegram_chat_id: chatId }).eq("id", data.id);
    }
    return data;
  }
  const { data: created, error } = await db
    .from("users")
    .insert({ telegram_user_id: telegramUserId, telegram_chat_id: chatId })
    .select()
    .single();
  if (error) throw error;
  return created;
}

// ── /add ─────────────────────────────────────────────────────────────────────
async function addItem(user, chatId, url) {
  const { data: defendedCount } = await db.rpc("count_defended_subscriptions", { p_user_id: user.id });
  const { data: keyRow } = await db.from("user_api_keys").select("user_id").eq("user_id", user.id).maybeSingle();

  const plan = await planAdd(url, {
    detectAdapter,
    userHasKey: Boolean(keyRow),
    userDefendedCount: Number(defendedCount ?? 0),
  });

  if (plan.logRequest) await db.rpc("log_site_request", { p_url: url });
  if (plan.action !== "track") return reply(chatId, plan.message);

  // Resolve the ids this adapter needs FROM THE URL. If we can't, say so now —
  // "Tracking this!" followed by permanent silence is the worst outcome.
  const res = resolveSelector(url, plan.adapter);
  if (!res.ok) {
    await db.rpc("log_site_request", { p_url: url });
    return reply(chatId, `I can read ${new URL(url).hostname}, but ${res.reason}. Nothing is being tracked.`);
  }
  let selector = res.selector;
  if (res.needsPage) {
    const page = await resolveFromPage(url);
    if (!page.ok) {
      await db.rpc("log_site_request", { p_url: url });
      return reply(chatId, `I can read ${new URL(url).hostname}, but ${page.reason}. Nothing is being tracked.`);
    }
    selector = { ...selector, ...page.patch };
  }

  // One row per URL: N subscribers => 1 fetch.
  let { data: product } = await db.from("tracked_products").select("*").eq("url", url).maybeSingle();
  if (!product) {
    const { data, error } = await db
      .from("tracked_products")
      .insert({
        url,
        adapter: plan.adapter,
        fetch_strategy: plan.strategy,
        title: (await fetchTitle(url)) ?? labelFromUrl(url),
        variant_selector: selector,
        check_interval_minutes: plan.intervalMinutes,
        next_check_at: new Date().toISOString(),
      })
      .select()
      .single();
    if (error) throw error;
    product = data;
  } else if (plan.intervalMinutes < product.check_interval_minutes) {
    // The product's clock is the MIN over its subscribers.
    await db.from("tracked_products")
      .update({ check_interval_minutes: plan.intervalMinutes })
      .eq("id", product.id);
  }

  const { data: existing } = await db.from("subscriptions")
    .select("id").eq("user_id", user.id).eq("product_id", product.id).maybeSingle();
  if (existing) return reply(chatId, `Already on your list: ${product.title}\nUse /list to see it.`);

  const { error } = await db.from("subscriptions").insert({ user_id: user.id, product_id: product.id });
  if (error) throw error;

  return reply(chatId, [
    `👀 ${plan.message}`,
    product.title,
    `Watching: ${res.watching}.`,
    "I'll send a baseline reading shortly, then only when something changes.",
  ].join("\n"));
}

// ── /list (the numbering every other command refers to) ──────────────────────
async function subscriptionList(userId) {
  const { data } = await db
    .from("subscriptions")
    .select("id, status, target_price, last_alert_price, tracked_products(id, url, title, fetch_strategy)")
    .eq("user_id", userId)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });
  return data ?? [];
}

async function listItems(user, chatId) {
  const subs = await subscriptionList(user.id);
  if (!subs.length) return reply(chatId, "Your list is empty — paste a product link to start tracking.");

  const lines = subs.map((s, i) => {
    const p = s.tracked_products;
    const bits = [];
    if (s.last_alert_price != null) bits.push(`now ${s.last_alert_price}`);
    if (s.target_price != null) bits.push(`target ${s.target_price}`);
    if (s.status === "paused") bits.push("paused");
    if (p.fetch_strategy === "unblocker") bits.push("daily/your key");
    return `${i + 1}. ${p.title}${bits.length ? `\n   ${bits.join(" · ")}` : ""}\n   ${p.url}`;
  });
  return reply(chatId, `Tracking ${subs.length} item${subs.length > 1 ? "s" : ""}:\n\n${lines.join("\n\n")}`);
}

// ── /remove /pause /resume /setprice — all address items by list number ──────
async function mutate(user, chatId, ref, action, price) {
  const subs = await subscriptionList(user.id);
  const n = Number(ref);
  if (!Number.isInteger(n) || n < 1 || n > subs.length) {
    return reply(chatId, `Use the number from /list (1–${subs.length || 0}).`);
  }
  const sub = subs[n - 1];
  const title = sub.tracked_products.title;

  if (action === "remove") {
    await db.from("subscriptions").delete().eq("id", sub.id);
    await retireIfOrphaned(sub.tracked_products.id);
    return reply(chatId, `🗑️ Stopped tracking ${title}`);
  }
  if (action === "pause") {
    await db.from("subscriptions").update({ status: "paused" }).eq("id", sub.id);
    return reply(chatId, `🔕 Paused ${title}`);
  }
  if (action === "resume") {
    await db.from("subscriptions").update({ status: "active" }).eq("id", sub.id);
    return reply(chatId, `🔔 Resumed ${title}`);
  }
  if (action === "setprice") {
    await db.from("subscriptions").update({ target_price: price }).eq("id", sub.id);
    return reply(chatId, `🎯 I'll alert you when ${title} hits ${price} or below.`);
  }
}

/** Nobody left watching a URL => stop paying to fetch it. */
async function retireIfOrphaned(productId) {
  const { count } = await db.from("subscriptions")
    .select("id", { count: "exact", head: true })
    .eq("product_id", productId);
  if (!count) await db.from("tracked_products").update({ status: "dead" }).eq("id", productId);
}

// ── /setkey ──────────────────────────────────────────────────────────────────
async function setKey(user, chatId, key) {
  if (!/^[A-Za-z0-9_\-=]{20,}$/.test(key)) {
    return reply(chatId, "That doesn't look like a ScrapingBee API key. Copy it from your ScrapingBee dashboard and send /setkey <key> again.");
  }
  const { error } = await db.rpc("set_user_api_key", { p_user_id: user.id, p_key: key });
  if (error) throw error;
  return reply(chatId, [
    "🔐 Key saved (encrypted) and your message deleted.",
    `You can now track bot-protected stores — up to ${MAX_DEFENDED} of them, checked once a day so your credits last.`,
    "Paste one of those links to try it.",
  ].join("\n"));
}
