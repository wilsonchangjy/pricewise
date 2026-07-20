// Telegram webhook — turns chat messages into rows.
//
// Telegram retries anything that isn't a 2xx, so this ALWAYS returns 200 once
// the shared-secret header checks out; errors are reported to the user in-chat
// instead of by status code.

// @ts-nocheck  (the _shared modules are plain ESM/JSDoc, shared with the Node tests)
import { createClient } from "jsr:@supabase/supabase-js@2";
import { parseCommand } from "../_shared/commands.mjs";
import { planAdd, MAX_DEFENDED, MAX_ITEMS, INTERVAL_OPTIONS, MIN_INTERVAL_MIN, FREE_INTERVAL_MIN, DEFENDED_INTERVAL_MIN } from "../_shared/policy.mjs";
import { detectAdapter } from "../_shared/router.mjs";
import { sendMessage, deleteMessage } from "../_shared/telegram.mjs";
import { labelFromUrl } from "../_shared/label.mjs";
import { resolveSelector, resolveFromPage, fetchTitle } from "../_shared/resolve.mjs";
import { cleanUrl } from "../_shared/urlguard.mjs";
import { formatHistory } from "../_shared/history.mjs";
import { CATEGORIES, detectCategory, normalizeCategory } from "../_shared/category.mjs";
import { matchVariant } from "../_shared/variants.mjs";

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const WEBHOOK_SECRET = Deno.env.get("TELEGRAM_WEBHOOK_SECRET") ?? "";
const ALLOWED = new Set(
  (Deno.env.get("ALLOWED_TELEGRAM_IDS") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
);
// Flip this secret to true to open the bot to anyone. Banned users stay banned:
// promotion below checks banned_at, which auto-signup must never override.
const OPEN_SIGNUPS_ENV = (Deno.env.get("OPEN_SIGNUPS") ?? "").trim().toLowerCase() === "true";

/** app_settings wins, env is the fallback — so opening/closing is one UPDATE. */
async function openSignups() {
  const { data } = await db.from("app_settings").select("value").eq("key", "open_signups").maybeSingle();
  if (data?.value === true || data?.value === "true") return true;
  if (data?.value === false || data?.value === "false") return false;
  return OPEN_SIGNUPS_ENV;
}

const db = createClient(
  Deno.env.get("SUPABASE_URL"),
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false } },
);

const WELCOME = [
  "👋 Welcome to Pricewise.",
  "",
  "Paste any product link and I'll watch it for you — I check on a schedule and",
  "message you when your size comes back in stock or the price drops.",
  "",
  "Two things worth knowing:",
  "• My first message about an item is just a starting point, not a change.",
  "• If the shop doesn't put your size in the link, use /size to pick one.",
  "",
  "Send /help any time for the full list of commands.",
].join("\n");

const HELP = [
  "🛍️ Pricewise — I watch your items and ping you when your size restocks or the price drops.",
  "",
  "Paste a product link to start tracking it.",
  "",
  "/list — your tracked items",
  "/size <n> <your size> — watch one size instead of the whole product",
  "/every <n> <3h|6h|12h|1d> — how often to check (default 6h)",
  "/history <n> [1m|3m|6m|1y] — price history since I started watching",
  "",
  "/prefs — your defaults and limits",
  "/setsize <tops|bottoms|shoes> <size> — I'll use it on new items automatically",
  "/setevery <3h|6h|12h|1d> — default check frequency for new items",
  "/remove <n> — stop tracking one",
  "/setprice <n> <price> — only alert me at/below this",
  "/pause <n> · /resume <n> — mute / unmute",
  "/setkey <key> — your own ScrapingBee key for bot-protected stores",
  "   (I delete that message from the chat the moment I read it)",
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

const TIP = "\n\nTip: open the product page in your browser, choose the colour/size, then copy the link straight from the address bar.";
const ok = () => new Response("ok", { status: 200 });
const reply = (chatId, text) => sendMessage(BOT_TOKEN, chatId, text);

async function handle(msg, chatId, fromId) {
  // Groups and channels only cause harm here: chat.id != from.id, so one person's
  // wishlist (and their /setkey) would spill to everyone in the room. Refuse
  // before a user row is created, so a group never becomes someone's account.
  const chatType = msg.chat?.type ?? "private";
  if (chatType !== "private") {
    return sendMessage(BOT_TOKEN, chatId, "I only work in a direct message — your list and alerts are private to you. Message me one-to-one and I'll get started.");
  }

  const intent = parseCommand(msg.text);

  // A key must never linger in the chat history — scrub it before anything else.
  if (intent.redactMessage) await deleteMessage(BOT_TOKEN, chatId, msg.message_id);

  const user = await upsertUser(fromId, chatId);

  // A ban is sticky and outranks everything below it.
  if (user.banned_at) {
    return reply(chatId, "This account no longer has access to Pricewise.");
  }

  // ALLOWED_TELEGRAM_IDS is a bootstrap hatch; users.is_allowed is the truth the
  // CHECKER reads. Promote into the column so the two can never disagree —
  // otherwise someone allowed only by env gets commands but silently no alerts.
  const isNew = !user.is_allowed;
  if (isNew && (ALLOWED.has(String(fromId)) || (await openSignups()))) {
    await db.from("users").update({ is_allowed: true }).eq("id", user.id);
    user.is_allowed = true;
    // First contact: lead with what the bot does, not with silence.
    await reply(chatId, WELCOME);
  }
  if (!user.is_allowed) {
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
    case "size":    return setSize(user, chatId, intent.ref, intent.value);
    case "every":   return setEvery(user, chatId, intent.ref, intent.value);
    case "history": return showHistory(user, chatId, intent.ref, intent.value);
    case "prefs":   return showPrefs(user, chatId);
    case "setsize": return setDefaultSize(user, chatId, intent.category, intent.value);
    case "setevery":return setDefaultEvery(user, chatId, intent.value);
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
async function addItem(user, chatId, rawUrl) {
  // Strangers choose what we fetch, so the link is checked BEFORE any request:
  // public http(s) only, and campaign junk stripped so shared items dedupe.
  const clean = cleanUrl(rawUrl);
  if (!clean.ok) return reply(chatId, `${clean.reason}. Send me a normal product link and I'll take it from there.`);
  const url = clean.url;

  // One person shouldn't be able to eat the whole check budget. Counts the WHOLE
  // list (paused included) so "how many can I have?" has one predictable answer.
  const { count: listSize } = await db.from("subscriptions")
    .select("id", { count: "exact", head: true }).eq("user_id", user.id);
  if ((listSize ?? 0) >= MAX_ITEMS) {
    return reply(chatId, `Your list is full at ${MAX_ITEMS} items — /remove one to make room. (/list shows them, oldest first.)`);
  }

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
    return reply(chatId, `I know ${new URL(url).hostname}, but ${res.reason}.\n\nNothing is being tracked — send another link and I'll try again.` + TIP);
  }
  let selector = res.selector;
  if (res.needsPage) {
    const page = await resolveFromPage(url);
    if (!page.ok) {
      await db.rpc("log_site_request", { p_url: url });
      return reply(chatId, `I know ${new URL(url).hostname}, but ${page.reason}.\n\nNothing is being tracked — send another link and I'll try again.` + TIP);
    }
    selector = { ...selector, ...page.patch };
  }

  // One row per URL: N subscribers => 1 fetch.
  let { data: product } = await db.from("tracked_products").select("*").eq("url", url).maybeSingle();
  if (!product) {
    // The global circuit breaker guards DISTINCT urls, because that's what costs
    // a fetch and a readings row. Joining something already watched is always
    // allowed — it adds a subscriber, not load.
    const { data: cap } = await db.rpc("capacity_status");
    const capacity = Array.isArray(cap) ? cap[0] : cap;
    if (capacity?.at_capacity) {
      console.warn(`/add refused at capacity: ${capacity.tracked}/${capacity.ceiling}`);
      await db.rpc("log_site_request", { p_url: url });
      return reply(chatId, "I'm at capacity right now and not taking on new products — I'd rather check the existing ones on time than check everything late. Try again later; anything already on your list keeps running.");
    }

    const { data, error } = await db
      .from("tracked_products")
      .insert({
        url,
        adapter: plan.adapter,
        fetch_strategy: plan.strategy,
        title: (await fetchTitle(url)) ?? labelFromUrl(url),
        variant_selector: selector,
        check_interval_minutes: preferredInterval(user, plan),
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

  // If they've told us a default size for this kind of garment, park it — the
  // first successful check resolves it against the shop's real size labels.
  const category = detectCategory(product.title, url);
  const pendingSize = category ? (user.settings?.sizes ?? {})[category] : null;

  const { error } = await db.from("subscriptions").insert({
    user_id: user.id,
    product_id: product.id,
    interval_minutes: preferredInterval(user, plan),
    pending_size: pendingSize ?? null,
  });
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

// ── /size ── pick ONE variant to watch, after the fact ───────────────────────
// Many shops (COS, Mango, most Shopify stores) don't put the size in the URL at
// all, so /add can only watch the whole product. This is how you narrow it: we
// match your words against the size labels the shop itself returned.
async function setSize(user, chatId, ref, value) {
  const sub = await subAt(user, chatId, ref);
  if (!sub) return;
  const p = sub.tracked_products;

  const { data: rows } = await db
    .from("product_readings").select("variants")
    .eq("product_id", p.id).order("checked_at", { ascending: false }).limit(1);
  const variants = (rows?.[0]?.variants ?? []).filter((v) => v && v.label);
  if (!variants.length) {
    return reply(chatId, `I haven't managed to read ${p.title} yet — give it one check cycle, then try /size again.`);
  }

  const hit = matchVariant(variants, value);
  if (!hit) {
    return reply(chatId, [
      `I couldn't find "${value}" on ${p.title}.`,
      `What that shop offers: ${variants.map((v) => v.label).join(", ")}`,
      "Send /size " + ref + " <one of those>.",
    ].join("\n"));
  }

  // Clearing the dedup state re-baselines on the chosen size, so the next check
  // tells you where THAT size stands rather than staying silent.
  await db.from("subscriptions")
    .update({ variant_id: String(hit.id), variant_label: hit.label, last_alert_status: null, last_alert_price: null })
    .eq("id", sub.id);

  // ...and bring that check forward. Waiting for the normal cadence meant the
  // size baseline landed HOURS later, by which time you've forgotten you asked —
  // so a snapshot ("out of stock") reads like breaking news.
  await db.from("tracked_products").update({ next_check_at: new Date().toISOString() }).eq("id", p.id);

  const known = hit.available === false ? " (it's out of stock right now)" : hit.available ? " (in stock right now)" : "";
  return reply(chatId, `👕 Got it — watching ${hit.label} on ${p.title}${known}.\nChecking that size now; you'll get its starting point in a few minutes.`);
}


// ── /every ── how often YOU want this checked ────────────────────────────────
async function setEvery(user, chatId, ref, value) {
  const minutes = INTERVAL_OPTIONS[value];
  if (!minutes) return reply(chatId, `Choose one of: ${Object.keys(INTERVAL_OPTIONS).join(", ")} — e.g. /every ${ref} 6h`);

  const sub = await subAt(user, chatId, ref);
  if (!sub) return;
  const p = sub.tracked_products;

  if (p.fetch_strategy === "unblocker" && minutes < DEFENDED_INTERVAL_MIN) {
    return reply(chatId, "Bot-protected items stay on a once-a-day check — they spend your own ScrapingBee credits, and a faster cadence would burn through them.");
  }

  await db.from("subscriptions").update({ interval_minutes: minutes }).eq("id", sub.id);

  // The product's clock is the MIN over everyone watching it (floored at 3h).
  const { data: all } = await db.from("subscriptions")
    .select("interval_minutes").eq("product_id", p.id).eq("status", "active");
  const wanted = (all ?? []).map((s) => s.interval_minutes ?? FREE_INTERVAL_MIN);
  const effective = Math.max(MIN_INTERVAL_MIN, Math.min(...wanted, FREE_INTERVAL_MIN));
  await db.from("tracked_products")
    .update({ check_interval_minutes: effective, next_check_at: new Date().toISOString() })
    .eq("id", p.id);

  return reply(chatId, `⏱️ ${p.title} — checking every ${value} now.`);
}

/** Shared "which item did you mean?" lookup for the numbered commands. */
async function subAt(user, chatId, ref) {
  const subs = await subscriptionList(user.id);
  const n = Number(ref);
  if (!Number.isInteger(n) || n < 1 || n > subs.length) {
    await reply(chatId, `Use the number from /list (1–${subs.length || 0}).`);
    return null;
  }
  return subs[n - 1];
}

// ── /history ── what we've actually seen, never more than that ───────────────
const RANGE_DAYS = { "1m": 30, "3m": 90, "6m": 180, "1y": 365 };

async function showHistory(user, chatId, ref, range) {
  const days = RANGE_DAYS[range] ?? 90;
  const sub = await subAt(user, chatId, ref);
  if (!sub) return;
  const p = sub.tracked_products;

  const [{ data: stats }, { data: points }] = await Promise.all([
    db.rpc("price_stats", { p_product_id: p.id, p_days: days }),
    db.rpc("price_history", { p_product_id: p.id, p_days: days }),
  ]);
  const s = Array.isArray(stats) ? stats[0] : stats;
  return reply(chatId, formatHistory(p, s, points ?? [], days));
}

// ── preferences ─────────────────────────────────────────────────────────────
// Stored on users.settings so they cost no schema churn:
//   { sizes: { tops:"M", bottoms:"32", shoes:"UK9" }, interval_minutes: 360 }

/** The interval a NEW item gets: the user's default, floored, and never faster
 *  than daily for defended sites (those spend their own unblocker credits). */
function preferredInterval(user, plan) {
  if (plan.strategy === "unblocker") return DEFENDED_INTERVAL_MIN;
  const pref = Number(user.settings?.interval_minutes);
  if (!Number.isFinite(pref)) return plan.intervalMinutes;
  return Math.max(MIN_INTERVAL_MIN, pref);
}

const intervalWord = (min) =>
  Object.entries(INTERVAL_OPTIONS).find(([, v]) => v === Number(min))?.[0] ?? `${min}min`;

async function showPrefs(user, chatId) {
  const sizes = user.settings?.sizes ?? {};
  const every = intervalWord(user.settings?.interval_minutes ?? FREE_INTERVAL_MIN);
  const { count } = await db.from("subscriptions")
    .select("id", { count: "exact", head: true }).eq("user_id", user.id);

  const sizeLines = CATEGORIES.map(
    (c) => `• ${c}: ${sizes[c] ? sizes[c] : "not set"}`,
  );

  return reply(chatId, [
    "⚙️ Your defaults",
    ...sizeLines,
    `• check every: ${every}`,
    "",
    "Set them with /setsize shoes UK9 · /setevery 6h",
    "New items pick these up automatically when I can tell what kind of thing they are.",
    "",
    "📏 Limits",
    `• ${count ?? 0}/${MAX_ITEMS} items on your list`,
    `• fastest check is 3h — most shops don't change prices faster than that, and`,
    "  checking harder mostly earns blocks rather than earlier alerts",
    `• bot-protected shops (Zara, ASOS…) are checked once a day on your own key`,
  ].join("\n"));
}

async function setDefaultSize(user, chatId, categoryWord, size) {
  const category = normalizeCategory(categoryWord);
  if (!category) {
    return reply(chatId, `I keep a default size for: ${CATEGORIES.join(", ")}.\ne.g. /setsize shoes UK9`);
  }
  const sizes = { ...(user.settings?.sizes ?? {}), [category]: size };
  await db.from("users").update({ settings: { ...(user.settings ?? {}), sizes } }).eq("id", user.id);

  return reply(chatId, [
    `📏 Default ${category} size set to ${size}.`,
    "I'll apply it to new items I can recognise as " + category + " — and tell you each time I do.",
    "It never changes anything already on your list; use /size for those.",
  ].join("\n"));
}

async function setDefaultEvery(user, chatId, value) {
  const minutes = INTERVAL_OPTIONS[value];
  if (!minutes) return reply(chatId, `Choose one of: ${Object.keys(INTERVAL_OPTIONS).join(", ")} — e.g. /setevery 6h`);
  await db.from("users").update({
    settings: { ...(user.settings ?? {}), interval_minutes: minutes },
  }).eq("id", user.id);
  return reply(chatId, [
    `⏱️ New items will be checked every ${value}.`,
    minutes <= MIN_INTERVAL_MIN
      ? "That's the fastest I go. Shops rarely move faster, and hammering them earns blocks, not earlier alerts."
      : "Change any single item with /every.",
  ].join("\n"));
}
