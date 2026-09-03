// Telegram webhook — turns chat messages into rows.
//
// Telegram retries anything that isn't a 2xx, so this ALWAYS returns 200 once
// the shared-secret header checks out; errors are reported to the user in-chat
// instead of by status code.

// @ts-nocheck  (the _shared modules are plain ESM/JSDoc, shared with the Node tests)
import { createClient } from "jsr:@supabase/supabase-js@2";
import { parseCommand } from "../_shared/commands.mjs";
import { planAdd, MAX_DEFENDED, MAX_ITEMS, INTERVAL_OPTIONS, MIN_INTERVAL_MIN, FREE_INTERVAL_MIN, DEFENDED_INTERVAL_MIN, ADAPTER_TIER, TIER_INTERVAL_MIN, monthlyCredits } from "../_shared/policy.mjs";
import { detectAdapter } from "../_shared/router.mjs";
import { sendMessage, deleteMessage, editMessage, answerCallback } from "../_shared/telegram.mjs";
import { labelFromUrl, displayTitle } from "../_shared/label.mjs";
import { localeFromUrl, currencyForCountry, MARKET_CHOICES, isKnownCountry, knownCountries } from "../_shared/locale.mjs";
import { resolveSelector, resolveFromPage, fetchTitle } from "../_shared/resolve.mjs";
import { cleanUrl } from "../_shared/urlguard.mjs";
import { expandUrl, isShortLink } from "../_shared/expand.mjs";
import { formatHistory } from "../_shared/history.mjs";
import { fmt } from "../_shared/alerting.mjs";
import { CATEGORIES, detectCategory, normalizeCategory } from "../_shared/category.mjs";
import { matchVariant } from "../_shared/variants.mjs";
import { PROVIDERS, DEFAULT_PROVIDER, normalizeProvider, detectProvider, providerSummary } from "../_shared/providers.mjs";
import { storesMessage } from "../_shared/stores.mjs";
import {
  parseCallback, listKeyboard, itemKeyboard, sizeKeyboard, everyKeyboard,
  confirmRemoveKeyboard, backToItemKeyboard, targetKeyboard, prefsKeyboard,
  setEveryIntervalKeyboard, setEveryScopeKeyboard, prefsSizeCategoryKeyboard,
  colourKeyboard, variantColours, candidateKeyboard, marketKeyboard, prefsCountryKeyboard } from "../_shared/keyboards.mjs";
import { probeMarketCurrency } from "../_shared/adapters/shopify.mjs";
import { findProduct, looksBroad, MAX_CANDIDATES } from "../_shared/search.mjs";
import { AI_PROVIDERS, detectAiProvider } from "../_shared/ai.mjs";

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
  "Don't have the link? Describe the item instead — \"Our Legacy Camion boots in",
  "black\" — and I'll go looking, then show you what I found to pick from.",
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
  "Paste a product link to start tracking it — or just describe the item",
  "(\"Our Legacy Camion boots in black\") and I'll go and find it.",
  "",
  "/list — your items. Tap one to set its size, a price-drop target, how often I check,",
  "   which country's storefront to watch, to see its price history, or to remove it.",
  "/stores — which shops I can track, and which need a key.",
  "/prefs — your defaults (sizes, check frequency, where you shop), limits and credits.",
  "/setkey <key> — add your own unblocker key for bot-protected stores.",
  "   (I delete that message from the chat the moment I read it — /providers lists the options.)",
  "/setaikey <key> — an Anthropic or OpenAI key, so I can search the web when the",
  "   free search can't tell which shop you mean. Deleted from the chat the same way.",
  "/help — this message.",
].join("\n");

Deno.serve(async (req) => {
  if (WEBHOOK_SECRET && req.headers.get("x-telegram-bot-api-secret-token") !== WEBHOOK_SECRET) {
    return new Response("forbidden", { status: 403 });
  }

  const update = await req.json().catch(() => null);

  // A tapped button, not a typed message.
  if (update?.callback_query) {
    try {
      await handleCallback(update.callback_query);
    } catch (e) {
      console.error("callback error:", e);
      await answerCallback(BOT_TOKEN, update.callback_query.id, "Something went wrong — try /list again.");
    }
    return ok();
  }

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

/** The call to action under a result list — dropped once the user has decided. */
const TAP_FOOTER = "Every price and stock line above I read off the page just now — nothing here is\na guess. Tap one to start tracking it.";

const TIP = "\n\nTip: open the product page in your browser, choose the colour/size, then copy the link straight from the address bar.";
const ok = () => new Response("ok", { status: 200 });
const reply = (chatId, text, opts) => sendMessage(BOT_TOKEN, chatId, text, opts);

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

  // Awaiting a default size? The next plain message is that size. A command or a
  // link means they moved on, so drop the pending state and let it route normally.
  const pending = user.settings?.pending;
  if (pending?.action === "setsize") {
    const text = (msg.text ?? "").trim();
    const looksLikeSize = text && !text.startsWith("/") && !/https?:\/\//i.test(text) && text.length <= 20;
    await clearPending(user);
    if (looksLikeSize) return setDefaultSize(user, chatId, pending.category, text);
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
    case "setkey":  return setKey(user, chatId, intent.key, intent.providerWord);
    case "setaikey":return intent.clear ? forgetAiKey(user, chatId) : setAiKey(user, chatId, intent.key);
    case "find":    return findItems(user, chatId, intent.query);
    case "providers": return showProviders(chatId);
    case "market":  return setMarket(user, chatId, intent.ref, intent.value);
    case "setcountry": return setDefaultCountry(user, chatId, intent.value);
    case "stores":  return reply(chatId, storesMessage());
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
  let clean = cleanUrl(rawUrl);
  if (!clean.ok) return reply(chatId, `${clean.reason}. Send me a normal product link and I'll take it from there.`);

  // Share buttons hand out short links, and that's how people actually send
  // products around. Follow them to the real URL before anything tries to
  // recognise the store — otherwise "amzn.asia" reads as an unsupported site.
  if (isShortLink(clean.url)) {
    const expanded = await expandUrl(clean.url);
    if (!expanded.ok) {
      return reply(chatId, `That share link didn't lead anywhere I could read (${expanded.reason}). Try opening it and copying the full product link.`);
    }
    const recleaned = cleanUrl(expanded.url);
    if (recleaned.ok) clean = recleaned;
  }
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

  // One row per URL *AND MARKET*: N subscribers in the same market => 1 fetch.
  //
  // A shop's price and stock differ per market — measured on mutimer.co, the
  // same variant is 240.00 and in stock on the UK storefront while being 380.00
  // and out of stock unpinned. Two people in different countries are watching
  // genuinely different offers, so they cannot share a row.
  // PRECEDENCE: the link's own locale, then the account default.
  //
  // A URL that says /en-us/ or /sg/ has already answered the question — the
  // person chose that storefront by pasting it, and overriding them with an
  // account default would pin a US link to the SG market and then report prices
  // nobody can buy at. The account default only fills the gap where the link is
  // silent, which is exactly the path-less sites (Shopify Markets, most of the
  // long tail) where there is nothing else to go on.
  //
  // A per-item pin set afterwards beats both — see setMarket().
  const market = localeFromUrl(url).country ?? (await shopperCountry(user));
  let { data: product } = await db.from("tracked_products").select("*")
    .eq("url", url).eq("market", market ?? null).maybeSingle();
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
        market: market ?? null,
        currency: market ? (await resolveMarketCurrency(url, market, plan.adapter)).currency : null,
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
    // A variant named in the URL beats a saved default — they picked it deliberately.
    variant_id: res.variantId ?? null,
    pending_size: res.variantId ? null : (pendingSize ?? null),
  });
  if (error) throw error;

  return reply(chatId, [
    `👀 ${plan.message}`,
    product.title,
    `Watching: ${res.watching}.`,
    ...(market ? [`Prices and stock from the ${market} storefront — say so if you shop a different one.`] : []),
    ...(await costNote(user, plan, product)),
    "I'll send a baseline reading shortly, then only when something changes.",
  ].join("\n"));
}

// ── /list (the numbering every other command refers to) ──────────────────────
async function subscriptionList(userId) {
  const { data } = await db
    .from("subscriptions")
    // EVERY column a market move needs, not just the ones the list PRINTS.
    // Omitting adapter/market/variant_selector here is what made 🌐 Market fail:
    // productForMarket() inserted a row with adapter undefined, adapter is NOT
    // NULL with no default, and the throw surfaced as "Something went wrong".
    // It only worked when a row for that (url, market) already existed — which
    // is exactly why SG succeeded on the two already-pinned items and nothing
    // else did.
    .select("id, status, target_price, last_alert_price, tracked_products(id, url, title, adapter, fetch_strategy, currency, market, variant_selector, check_interval_minutes)")
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
    if (s.last_alert_price != null) bits.push(`now ${fmt(Number(s.last_alert_price), p.currency)}`);
    if (s.target_price != null) bits.push(`target ${fmt(Number(s.target_price), p.currency)}`);
    if (s.status === "paused") bits.push("paused");
    if (p.fetch_strategy === "unblocker") bits.push("daily/your key");
    return `${i + 1}. ${displayTitle(p)}${bits.length ? `\n   ${bits.join(" · ")}` : ""}\n   ${p.url}`;
  });
  return sendMessage(BOT_TOKEN, chatId,
    `Tracking ${subs.length} item${subs.length > 1 ? "s" : ""} — tap a number to change one:\n\n${lines.join("\n\n")}`,
    { keyboard: listKeyboard(subs) });
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

// ── /setkey ─────────────────────────────────────────────────────────────────
// Provider-aware: "/setkey scraperapi abc123" names it, "/setkey abc123" infers
// it from the key's shape. Ambiguous keys are ASKED about, never guessed — a
// wrong guess sends every future request to the wrong vendor and looks exactly
// like a blocked site.
async function setKey(user, chatId, key, providerWord) {
  const named = providerWord ? normalizeProvider(providerWord) : null;
  if (providerWord && !named) {
    return reply(chatId, `I don't know the provider "${providerWord}". Try /providers to see the options.`);
  }

  const provider = named ?? detectProvider(key);
  if (!provider) {
    return reply(chatId, [
      "I can't tell which service that key is for — several use the same format.",
      "Send it with the name, e.g.:",
      "/setkey scraperapi <key>",
      "",
      "See /providers for the list.",
    ].join("\n"));
  }

  const p = PROVIDERS[provider];
  if (!p.keyPattern.test(String(key).trim())) {
    return reply(chatId, `That doesn't look like a ${p.label} key. Copy it from your ${p.label} dashboard and try again.`);
  }

  const { error } = await db.rpc("set_user_api_key", {
    p_user_id: user.id, p_key: String(key).trim(), p_provider: provider,
  });
  if (error) throw error;

  return reply(chatId, [
    `🔐 ${p.label} key saved (encrypted) and your message deleted.`,
    `You can now track bot-protected stores — up to ${MAX_DEFENDED} of them.`,
    "How often I check each one depends on what it costs: the cheap ones every 6h,",
    "the priciest once a day. I'll tell you the cost before you add anything.",
    p.verified ? "" : `Heads up: I haven't been able to test ${p.label} end to end yet, so tell me if a check fails and I'll dig in.`,
    "Paste one of those links to try it.",
  ].filter(Boolean).join("\n"));
}

async function showProviders(chatId) {
  // Renewing tiers first — that property matters more than the headline number.
  const lines = providerSummary()
    .sort((a, b) => Number(b.freeNote.includes("renews")) - Number(a.freeNote.includes("renews")))
    .map((p) =>
    `• ${p.label}${p.verified ? "" : " (untested by me)"}\n  ${p.freeNote}\n  ${p.signup}`);
  return sendMessage(BOT_TOKEN, chatId, [
    "🔑 Bot-protected shops (Amazon, eBay, Zara, Massimo Dutti, ASOS…) need an unblocker service.",
    "Bring your own key — you stay in control of the spend:",
    "",
    ...lines,
    "",
    "Then: /setkey <provider> <key>",
    "I delete that message the moment I read it.",
    "",
    "Both are tested. Scrape.do is the one to pick if you're starting fresh —",
    "its free credits renew every month, where ScrapingBee's are a one-off trial.",
  ].join("\n"));
}

// ── describe an item, and I'll go find it ────────────────────────────────────
// The free search (a shop's own search endpoint) runs for everyone. It can only
// query a shop it can LOCATE, so it handles "goshopia scarlett dress" and not
// "black leather chelsea boots". A model key fills that gap on the user's own
// account — and only when the free path came back empty, so the common case
// stays free.

async function setAiKey(user, chatId, key) {
  const provider = detectAiProvider(key);
  const p = provider ? AI_PROVIDERS[provider] : null;
  if (!p || !p.keyPattern.test(String(key).trim())) {
    return reply(chatId, [
      "That doesn't look like an Anthropic or OpenAI key.",
      "",
      ...Object.values(AI_PROVIDERS).map((v) => `• ${v.label} — ${v.signup}`),
      "",
      "Then: /setaikey <key>. I delete that message the moment I read it.",
    ].join("\n"));
  }

  const { error } = await db.rpc("set_user_ai_key", {
    p_user_id: user.id, p_key: String(key).trim(), p_provider: provider,
  });
  if (error) throw error;

  return reply(chatId, [
    `🔑 ${p.label} key saved (encrypted) and your message deleted.`,
    "",
    "Now you can describe an item instead of pasting a link — try:",
    "  Our Legacy Camion boots in black",
    "",
    "I search the shops I can read, show you what I actually found, and you tap one",
    "to track it. I never quote a price I haven't read off the page myself.",
    "It's a few cents a search on your account, and only when the free search",
    "turns up nothing. /setaikey off to forget the key.",
  ].join("\n"));
}

async function forgetAiKey(user, chatId) {
  const { error } = await db.rpc("delete_user_ai_key", { p_user_id: user.id });
  if (error) throw error;
  return reply(chatId, "🔑 Forgotten — the key is deleted, not just unlinked. Describing an item still works on the free search; it just can't reach beyond a shop it can name.");
}

/**
 * Telegram re-delivers any update it hasn't seen a 200 for within about a minute.
 * A search can honestly take longer: a model turn with web search, then up to six
 * pages read through real adapters. A retry would run the whole thing a second
 * time and bill the user's model account twice — so this handler answers Telegram
 * straight away and finishes the work in the background.
 */
function inBackground(p) {
  const rt = (globalThis as any).EdgeRuntime;
  const guarded = p.catch((e: unknown) => console.error("search error:", e));
  if (rt?.waitUntil) { rt.waitUntil(guarded); return; }
  return guarded; // local/Node: nothing to hand off to, so see it through
}

/**
 * How long we're willing to hold the webhook open for a search.
 *
 * Telegram re-delivers an update it hasn't seen a 200 for in about a minute, so
 * this has to stay under that. Everything else about the timing is measured:
 * a typical search is 15–35s (Uniqlo 14.5s, Jacquemus 26.8s, Castlery 36s), and
 * the slow tail is a bot-protected shop climbing unblocker tiers.
 */
const SEARCH_DEADLINE_MS = 50_000;

/** A correction supersedes a search; an unrelated question an hour later does not. */
const SUPERSEDE_WINDOW_MS = 3 * 60_000;

/**
 * Fix a typo and Telegram sends the correction as a NEW update (edited_message),
 * so both the typo and the correction ran as separate searches — two "looking
 * for…" messages, two answers, two lots of the user's model credits. Observed
 * live: "Smart Wide Straight Pangs" and "…Pants" both searched.
 *
 * The in-flight fetch can't be recalled, so instead each search stamps a token on
 * the user's row and only reports back if that token is still the current one.
 * The superseded search finishes quietly and its result is dropped; its "looking
 * for…" message is deleted so the chat reads as though only the corrected query
 * was ever sent.
 */
async function findItems(user, chatId, query) {
  // Supersede a search only while it could still be a CORRECTION of itself.
  // Unbounded, this deleted a "looking for Uniqlo" message an hour after the
  // fact when an unrelated question was asked — because the Uniqlo search had
  // died without ever clearing its marker, so it looked forever in-flight.
  const previous = user.settings?.search;
  const recent = previous?.startedAt && Date.now() - previous.startedAt < SUPERSEDE_WINDOW_MS;
  if (previous?.ackMessageId && recent) {
    await deleteMessage(BOT_TOKEN, chatId, previous.ackMessageId);
  }

  const token = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ack = await reply(chatId, `🔎 Looking for “${query}” — give me a moment.`);

  const settings = {
    ...(user.settings ?? {}),
    search: { token, query, startedAt: Date.now(), ackMessageId: ack?.result?.message_id ?? null },
  };
  user.settings = settings;
  await db.from("users").update({ settings }).eq("id", user.id);

  // THE WORK RUNS INLINE, not in the background.
  //
  // It used to be handed to EdgeRuntime.waitUntil so the webhook could answer
  // Telegram instantly. That is not a place a 15-second job survives: once we
  // return 200 the isolate is reclaimed, the search dies mid-flight, and the
  // only trace was a console.error nobody reads. Live result — two searches,
  // an acknowledgement each, and then silence forever.
  //
  // So: await it, bounded by a deadline that keeps us inside Telegram's retry
  // window. Whatever happens, the user hears back.
  const work = runSearch(user, chatId, query, token);
  const TIMED_OUT = Symbol("deadline");
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), SEARCH_DEADLINE_MS);
  });

  const outcome = await Promise.race([
    work.then(() => "done", (e) => e ?? new Error("search failed")),
    deadline,
  ]);
  clearTimeout(timer);

  if (outcome === TIMED_OUT) {
    // Still going. Say so — then let it finish opportunistically. If the isolate
    // survives, the results still arrive; if it doesn't, the user has been told
    // rather than left waiting on a message that will never come.
    await reply(chatId, [
      `Still looking for “${query}” — it's taking longer than usual, which usually`,
      "means a shop that's slow to answer.",
      "",
      "I'll send results if they land. If nothing arrives in a minute or two, ask me",
      "again — I remember where I've already looked, so a retry is quick and cheap.",
    ].join("\n"));
    return inBackground(work);
  }

  if (outcome !== "done") {
    console.error("search failed:", outcome);
    await clearSearchToken(user, token);
    return reply(chatId, [
      `Something went wrong searching for “${query}” — that's my end, not yours.`,
      "Try again in a moment, or paste the product link and I'll track it directly.",
    ].join("\n"));
  }
}

/**
 * Is this search still the one the user is waiting for?
 *
 * FAILS OPEN, deliberately. Only a DIFFERENT token in the row supersedes this
 * search — a read error, or a missing marker, means "I can't tell", and the
 * right answer then is to report. A duplicate message is a small annoyance; a
 * silently discarded answer is the bug that brought us here.
 */
async function stillCurrent(user, token) {
  const { data, error } = await db.from("users").select("settings").eq("id", user.id).maybeSingle();
  if (error) return true;
  const current = data?.settings?.search?.token ?? null;
  return current === null || current === token;
}

/** Done reporting — drop the marker so a later edit doesn't delete a live ack. */
async function clearSearchToken(user, token) {
  const { data } = await db.from("users").select("settings").eq("id", user.id).maybeSingle();
  if ((data?.settings?.search?.token ?? null) !== token) return; // someone else owns it now
  const settings = { ...(data.settings ?? {}) };
  delete settings.search;
  user.settings = settings;
  await db.from("users").update({ settings }).eq("id", user.id);
}

/**
 * Which country's shops is this person actually shopping in?
 *
 * Derived from what they already track rather than asked for. A brand that runs
 * one site per country (Castlery, Uniqlo, IKEA) puts it right in the URL, so the
 * links someone has already chosen are the best evidence we have — and it costs
 * them no setup question. Falls back to a deployment default, then to nothing,
 * and "nothing" simply means no locale steer, which is how it behaved before.
 */
async function shopperCountry(user) {
  if (user.settings?.country) return String(user.settings.country).toUpperCase();

  const { data: rows } = await db
    .from("subscriptions")
    .select("tracked_products(url)")
    .eq("user_id", user.id)
    .limit(25);

  const tally = new Map();
  for (const r of rows ?? []) {
    const c = localeFromUrl(r.tracked_products?.url ?? "").country;
    if (c) tally.set(c, (tally.get(c) ?? 0) + 1);
  }
  const top = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
  return top?.[0] ?? ((Deno.env.get("PRICEWISE_COUNTRY") || "").toUpperCase() || undefined);
}

async function runSearch(user, chatId, query, token) {
  const [{ data: aiRows }, { data: keyRow }, country] = await Promise.all([
    db.rpc("get_user_ai_key", { p_user_id: user.id }),
    db.from("user_api_keys").select("user_id").eq("user_id", user.id).maybeSingle(),
    shopperCountry(user),
  ]);
  const ai = Array.isArray(aiRows) ? aiRows[0] : aiRows;

  const found = await findProduct(query, {
    ai: ai?.api_key ? { apiKey: ai.api_key, provider: ai.provider } : undefined,
    userHasUnblockerKey: Boolean(keyRow),
    country,
    max: MAX_CANDIDATES,
    // Remembering WHERE something was found makes a retry — and a second person
    // asking the same thing — free. The pages are still read fresh every time.
    cache: {
      get: async (key, c) => (await db.rpc("get_cached_search", { p_query: key, p_country: c ?? "" })).data,
      // async, so this returns a real Promise rather than a PostgREST builder.
      // A builder is a thenable without .catch(), and handing one to a caller
      // that reasonably expects a Promise is what broke every search that
      // found something. Awaiting here also turns a Postgres error into a
      // rejection instead of a quietly-resolved { error } nobody inspects.
      put: async (key, c, urls) => {
        const { error } = await db.rpc("put_cached_search", { p_query: key, p_country: c ?? "", p_urls: urls });
        if (error) throw error;
      },
    },
  });

  // The user edited or re-asked while this was running — answer only the
  // question they're actually waiting on.
  if (token && !(await stillCurrent(user, token))) {
    console.log(`search superseded, discarding results for "${query}"`);
    return;
  }
  await clearSearchToken(user, token);

  if (!found.length) {
    // Say WHICH kind of nothing this is. "No results" and "your key was rejected"
    // need different things from the user, and one message for both teaches them
    // to distrust the feature.
    const note = (found.notes ?? [])[0];
    return reply(chatId, [
      note ? `I couldn't complete that search — ${note}.` : `I couldn't find “${query}” anywhere I can read.`,
      "",
      ...(note ? [] : [
        ai?.api_key
          ? "Naming the brand and the product usually helps (\"Our Legacy Camion boots\" rather than \"black leather boots\")."
          : "Right now I can only search a shop I can name from your words. /setaikey <key> lets me search the web with your own Anthropic or OpenAI key.",
      ]),
      "If you can find the product page yourself, paste the link and I'll track it from there.",
    ].filter(Boolean).join("\n"));
  }

  // Park the URLs on the user's row: callback_data is 64 bytes and a single
  // Farfetch link is longer than that, so the buttons carry an index into this.
  const candidates = found.map((c) => ({
    url: c.url,
    title: String(c.reading?.title || c.hint || labelFromUrl(c.url)),
  }));
  const settings = { ...(user.settings ?? {}), pending: { action: "find", query, candidates } };
  await db.from("users").update({ settings }).eq("id", user.id);

  // A page for the wrong country must never look like one you can act on: the
  // price is real, and irrelevant. Say so on the line rather than in a footnote.
  const foreign = found.some((c) => c.country && country && c.country !== country);

  const lines = found.map((c, i) => {
    const r = c.reading;
    const bits = [];
    if (r?.price != null) bits.push(fmt(Number(r.price), r.currency));
    bits.push(r?.available ? "in stock" : "sold out");
    if (c.country && country && c.country !== country) bits.push(`⚠️ ${c.country} site`);
    return `${i + 1}. ${candidates[i].title}\n   ${bits.join(" · ")}\n   ${c.url}`;
  });

  return sendMessage(BOT_TOKEN, chatId, [
    found.length === 1 ? "Found one I can read:" : `Found ${found.length} I can read:`,
    "",
    ...lines,
    "",
    TAP_FOOTER,
    ...(foreign
      ? ["", `⚠️ Marked pages are a different country's site${country ? ` (you shop ${country})` : ""} — I couldn't find`,
         "a local one for that item, so the price and stock may not apply to you."]
      : []),
    // These three share almost no words, so they're three different products
    // rather than one product at three shops — which only happens when the
    // description named a category instead of an item.
    ...(looksBroad(candidates.map((c) => c.title), query)
      ? ["", "These are different products, not the same one at three shops — “" + query + "”",
         "reads as a category. Naming the brand and product gets you the actual item",
         "(\"Sunday Riley C.E.O. vitamin C serum\" rather than \"vitamin c serum\")."]
      : []),
  ].join("\n"), { keyboard: candidateKeyboard(found.length) });
}

async function trackCandidate(user, chatId, messageId, cqId, arg, originalText = "") {
  const pending = user.settings?.pending;
  const i = Number(arg);
  const pick = pending?.action === "find" ? pending.candidates?.[i] : null;
  if (!pick) {
    await answerCallback(BOT_TOKEN, cqId, "That search has expired — describe it again.");
    return;
  }
  await clearPending(user);
  await answerCallback(BOT_TOKEN, cqId, "Adding…");
  // KEEP THE LIST, drop only the buttons. Replacing the card with a one-line
  // confirmation threw away the other options — and the whole point of showing
  // three is that you might want to come back to the ones you didn't take.
  // Telegram keeps the old keyboard unless explicitly replaced, so an EMPTY
  // keyboard is the removal.
  await editMessage(BOT_TOKEN, chatId, messageId,
    `${withoutTapFooter(originalText)}\n\n✅ Tracking #${i + 1} — ${pick.title}`,
    { keyboard: { inline_keyboard: [] } });
  return addItem(user, chatId, pick.url);
}

/** Strip the "tap one to track" invitation once something has been tapped. */
function withoutTapFooter(text) {
  const at = String(text ?? "").indexOf(TAP_FOOTER.split("\n")[0]);
  return at === -1 ? String(text ?? "") : String(text).slice(0, at).trimEnd();
}

async function dismissCandidates(user, chatId, messageId, cqId, originalText = "") {
  await clearPending(user);
  await answerCallback(BOT_TOKEN, cqId);
  // Same rule as tracking: the list stays, the buttons go. What was found is
  // worth keeping on screen even when none of it was wanted today.
  // Keep the list; drop the buttons AND the invitation to tap them, which is
  // just noise once the decision is made.
  return editMessage(BOT_TOKEN, chatId, messageId,
    `${withoutTapFooter(originalText)}\n\n— Nothing added. The links above still work if you change your mind.`,
    { keyboard: { inline_keyboard: [] } });
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

  const floorMin = defendedFloor(p);
  if (minutes < floorMin) {
    return reply(chatId, [
      `This one costs enough per check that I keep it to every ${intervalWord(floorMin)}.`,
      "It spends your own unblocker credits, and checking harder mostly burns them",
      "rather than finding things sooner.",
    ].join("\n"));
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

/**
 * The fastest cadence a bot-protected item is allowed, derived from what it
 * actually costs to check. Free stores have no floor beyond the global one.
 */
function defendedFloor(product) {
  if (product.fetch_strategy !== "unblocker") return MIN_INTERVAL_MIN;
  const tier = product.unblocker_tier ?? ADAPTER_TIER[product.adapter] ?? "render";
  return TIER_INTERVAL_MIN[tier] ?? DEFENDED_INTERVAL_MIN;
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
  if (plan.strategy === "unblocker") {
    // Start at the cadence this shop's cost earns (its tier floor), but honour a
    // defended default if the user set one — always the SLOWER of the two, since
    // the floor is the fastest we'll spend their credits, and the usual intent
    // (everything to daily) is slower still.
    const tier = ADAPTER_TIER[plan.adapter] ?? "render";
    const floor = TIER_INTERVAL_MIN[tier] ?? DEFENDED_INTERVAL_MIN;
    const pref = Number(user.settings?.interval_minutes_defended);
    return Number.isFinite(pref) ? Math.max(floor, pref) : floor;
  }
  const pref = Number(user.settings?.interval_minutes);
  if (!Number.isFinite(pref)) return plan.intervalMinutes;
  return Math.max(MIN_INTERVAL_MIN, pref);
}

const intervalWord = (min) =>
  Object.entries(INTERVAL_OPTIONS).find(([, v]) => v === Number(min))?.[0] ?? `${min}min`;

async function buildPrefsText(user) {
  const sizes = user.settings?.sizes ?? {};
  const every = intervalWord(user.settings?.interval_minutes ?? FREE_INTERVAL_MIN);
  const everyDefended = user.settings?.interval_minutes_defended;
  const { count } = await db.from("subscriptions")
    .select("id", { count: "exact", head: true }).eq("user_id", user.id);
  const { data: keyRow } = await db.from("user_api_keys")
    .select("provider, credits_remaining, credits_seen_at").eq("user_id", user.id).maybeSingle();
  const { data: aiRow } = await db.from("user_ai_keys")
    .select("provider").eq("user_id", user.id).maybeSingle();

  const sizeLines = CATEGORIES.map((c) => `• ${c}: ${sizes[c] ? sizes[c] : "not set"}`);

  return [
    "⚙️ Your defaults",
    ...sizeLines,
    `• check every: ${every}${everyDefended ? ` (bot-protected: ${intervalWord(everyDefended)})` : ""}`,
    "",
    "Set default sizes with /setsize shoes UK9. Use the button below to change how often I check.",
    "",
    "📏 Limits",
    `• ${count ?? 0}/${MAX_ITEMS} items on your list`,
    `• fastest check is 3h — most shops don't change prices faster than that, and`,
    "  checking harder mostly earns blocks rather than earlier alerts",
    `• bot-protected shops (Zara, Amazon, ASOS…) run on your own key, and how`,
    "  often depends on what each costs to check — 6h for the cheap ones, daily for Zara",
    ...(keyRow?.credits_remaining != null
      ? ["", `🔋 ${PROVIDERS[keyRow.provider]?.label ?? keyRow.provider}: ${keyRow.credits_remaining} credits left`,
         "   (as of your last bot-protected check — most free plans reset monthly)"]
      : keyRow
      ? ["", `🔑 ${PROVIDERS[keyRow.provider]?.label ?? keyRow.provider} key saved`]
      : []),
    "",
    "🔎 Describing an item instead of pasting a link",
    aiRow
      ? `• on — ${AI_PROVIDERS[aiRow.provider]?.label ?? aiRow.provider}, used only when the free search can't tell which shop you mean (/setaikey off to stop)`
      : "• free search only — I can look inside a shop I can name from your words, but not find the shop itself. /setaikey <Anthropic or OpenAI key> lifts that.",
  ].join("\n");
}

async function showPrefs(user, chatId) {
  return reply(chatId, await buildPrefsText(user), { keyboard: prefsKeyboard() });
}

/** The /prefs screen re-rendered in place (the ◀︎ Back target of the flows). */
async function renderPrefs(user, chatId, messageId, cqId) {
  if (cqId) await answerCallback(BOT_TOKEN, cqId);
  return editMessage(BOT_TOKEN, chatId, messageId, await buildPrefsText(user), { keyboard: prefsKeyboard() });
}

// ── /prefs → default sizes: pick a category, then TYPE the size ──────────────
// Sizes are free-form (UK9, M, 32), so there's no preset to tap. Choosing a
// category parks a `pending` marker in the user's settings; their next plain
// message is captured as the size (see the pending check in handle()).

function showPrefsSizes(chatId, messageId, cqId) {
  return answerCallback(BOT_TOKEN, cqId).then(() =>
    editMessage(BOT_TOKEN, chatId, messageId,
      "📏 Which category's default size?\nI apply it to new items I can recognise as that kind of thing — never anything already on your list.",
      { keyboard: prefsSizeCategoryKeyboard(CATEGORIES) }));
}

async function promptDefaultSize(user, chatId, messageId, cqId, category) {
  if (!CATEGORIES.includes(category)) return answerCallback(BOT_TOKEN, cqId);
  const settings = { ...(user.settings ?? {}), pending: { action: "setsize", category } };
  user.settings = settings;
  await db.from("users").update({ settings }).eq("id", user.id);
  await answerCallback(BOT_TOKEN, cqId);
  return editMessage(BOT_TOKEN, chatId, messageId,
    `📏 Send me your ${category} size — e.g. M, 32, or UK9.\n(Or /prefs to cancel.)`);
}

/** Drop a parked input marker (they typed the size, or moved on). */
async function clearPending(user) {
  if (!user.settings?.pending) return;
  const settings = { ...user.settings };
  delete settings.pending;
  user.settings = settings;
  await db.from("users").update({ settings }).eq("id", user.id);
}

// ── /setevery: pick an interval, then choose which items it applies to ───────

function showEveryInterval(chatId, messageId, cqId) {
  return answerCallback(BOT_TOKEN, cqId).then(() =>
    editMessage(BOT_TOKEN, chatId, messageId,
      "⏱ How often should I check?\n\nFastest is 3h — shops rarely move quicker, and checking harder mostly earns blocks. Bot-protected shops spend your own credits, so slower is cheaper there.",
      { keyboard: setEveryIntervalKeyboard() }));
}

const SCOPE_PROMPT = (interval) =>
  `⏱ Check every ${interval} — which items?\n\n• Free — the ones that don't need a key.\n• Bot-protected — the ones that spend your unblocker credits.\n• Both — everything on your list, and new ones.`;

function showEveryScope(chatId, messageId, cqId, interval) {
  if (!INTERVAL_OPTIONS[interval]) return answerCallback(BOT_TOKEN, cqId);
  return answerCallback(BOT_TOKEN, cqId).then(() =>
    editMessage(BOT_TOKEN, chatId, messageId, SCOPE_PROMPT(interval),
      { keyboard: setEveryScopeKeyboard(interval) }));
}

/**
 * Apply a chosen interval to a scope AND make it the default for new items in
 * that scope. Three scopes let the free and credit-spending items be tuned
 * independently: "free" touches non-defended items, "def" the bot-protected
 * ones, "both" everything. Each item is floored — a defended item can't be
 * driven faster than its tier allows — but setting things slower (the usual
 * intent: bot-protected to daily to save credits) is always fine.
 */
async function applyDefaultEvery(user, chatId, messageId, cqId, scope, interval) {
  const minutes = INTERVAL_OPTIONS[interval];
  if (!minutes) return answerCallback(BOT_TOKEN, cqId);

  // Store the default(s) for NEW items. "both" sets both so either kind inherits.
  const settings = { ...(user.settings ?? {}) };
  if (scope === "free" || scope === "both") settings.interval_minutes = minutes;
  if (scope === "def" || scope === "both") settings.interval_minutes_defended = minutes;
  await db.from("users").update({ settings }).eq("id", user.id);
  user.settings = settings;

  const isDefended = (s) => s.tracked_products?.fetch_strategy === "unblocker";
  const { data: subs } = await db.from("subscriptions")
    .select("id, tracked_products(id, adapter, fetch_strategy)")
    .eq("user_id", user.id).eq("status", "active");
  const inScope = (subs ?? []).filter((s) =>
    scope === "both" || (scope === "def" ? isDefended(s) : !isDefended(s)));

  const affected = new Set();
  for (const s of inScope) {
    const floored = Math.max(defendedFloor(s.tracked_products), minutes);
    await db.from("subscriptions").update({ interval_minutes: floored }).eq("id", s.id);
    affected.add(s.tracked_products.id);
  }
  for (const pid of affected) await recomputeProductInterval(pid);

  await answerCallback(BOT_TOKEN, cqId, "Saved");
  const word = scope === "def" ? "bot-protected " : scope === "free" ? "free " : "";
  const note = affected.size
    ? `Set your ${affected.size} ${word}item${affected.size > 1 ? "s" : ""} to every ${interval}, and new ${word}ones will default to that.`
    : `New ${word}items will default to every ${interval}. (You have none to update yet.)`;
  return editMessage(BOT_TOKEN, chatId, messageId, `⏱️ ${note}`, { keyboard: prefsKeyboard() });
}

/** A product's cadence is the fastest any of its watchers asked for. */
async function recomputeProductInterval(productId) {
  const { data: all } = await db.from("subscriptions")
    .select("interval_minutes").eq("product_id", productId).eq("status", "active");
  const effective = Math.max(MIN_INTERVAL_MIN,
    Math.min(...(all ?? []).map((x) => x.interval_minutes ?? FREE_INTERVAL_MIN), FREE_INTERVAL_MIN));
  await db.from("tracked_products").update({ check_interval_minutes: effective }).eq("id", productId);
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

/** /setevery launches the interval→scope flow. A valid interval argument skips
 *  straight to the scope choice; otherwise the interval picker opens first. */
async function setDefaultEvery(user, chatId, value) {
  if (value && INTERVAL_OPTIONS[value]) {
    return reply(chatId, SCOPE_PROMPT(value), { keyboard: setEveryScopeKeyboard(value) });
  }
  return reply(chatId,
    "⏱ How often should I check?\n\nPick an interval, then choose whether it applies to everything or only the bot-protected items that spend your credits.",
    { keyboard: setEveryIntervalKeyboard() });
}

// ── inline keyboard handling ────────────────────────────────────────────────
// Every branch re-loads the subscription BY OWNER. callback_data is user-supplied
// bytes: "i:12" is a claim about which item was tapped, not proof it's theirs.

async function handleCallback(cq) {
  const chatId = cq.message?.chat?.id;
  const messageId = cq.message?.message_id;
  const fromId = cq.from?.id;
  const parsed = parseCallback(cq.data);
  if (!chatId || !fromId || !parsed) return answerCallback(BOT_TOKEN, cq.id);

  const user = await upsertUser(fromId, chatId);
  if (user.banned_at || !user.is_allowed) {
    return answerCallback(BOT_TOKEN, cq.id, "This account doesn't have access.", true);
  }

  const { action, subId, arg } = parsed;

  if (action === "L") return renderList(user, chatId, messageId, cq.id);

  // Prefs / default-frequency flow — these carry no subscription, so they must
  // be handled before the per-item ownership lookup below.
  switch (action) {
    case "P":  return renderPrefs(user, chatId, messageId, cq.id);
    case "Ps": return showPrefsSizes(chatId, messageId, cq.id);
    case "Pc": return promptDefaultSize(user, chatId, messageId, cq.id, arg);
    case "Pe": return showEveryInterval(chatId, messageId, cq.id);
    case "Pm": return showPrefsCountry(user, chatId, messageId, cq.id);
    case "Pn": return applyDefaultCountry(user, chatId, messageId, cq.id, arg);
    case "Pi": return showEveryScope(chatId, messageId, cq.id, arg);
    case "Pf": return applyDefaultEvery(user, chatId, messageId, cq.id, "free", arg);
    case "Pd": return applyDefaultEvery(user, chatId, messageId, cq.id, "def", arg);
    case "Pa": return applyDefaultEvery(user, chatId, messageId, cq.id, "both", arg);
    // Search results: the button carries an index into the candidates parked on
    // the user's row, so there's no subscription to own yet.
    case "f":  return trackCandidate(user, chatId, messageId, cq.id, arg, cq.message?.text ?? "");
    case "fx": return dismissCandidates(user, chatId, messageId, cq.id, cq.message?.text ?? "");
  }

  const sub = subId === undefined ? null : await ownedSub(user.id, subId);
  if (!sub) {
    await answerCallback(BOT_TOKEN, cq.id, "That item isn't on your list any more.");
    return renderList(user, chatId, messageId);
  }

  switch (action) {
    case "i": return renderItem(sub, chatId, messageId, cq.id);
    case "s": return renderSizes(sub, chatId, messageId, cq.id);
    case "cc": return renderSizesForColour(sub, chatId, messageId, cq.id, arg);
    case "S": return applySize(sub, chatId, messageId, cq.id, arg);
    case "e":
      await answerCallback(BOT_TOKEN, cq.id);
      return editMessage(BOT_TOKEN, chatId, messageId,
        `⏱ How often should I check ${sub.tracked_products.title}?\n\nFastest is 3h — shops rarely move quicker, and checking harder mostly earns blocks.`,
        { keyboard: everyKeyboard(sub.id) });
    case "E": return applyEvery(sub, chatId, messageId, cq.id, arg);
    case "t": return showTarget(sub, chatId, messageId, cq.id);
    case "T": return applyTarget(sub, chatId, messageId, cq.id, arg);
    case "h": return renderHistory(sub, chatId, messageId, cq.id);
    case "m": return renderMarkets(user, sub, chatId, messageId, cq.id);
    case "M": return applyMarket(user, sub, chatId, messageId, cq.id, arg);
    case "p":
    case "u": {
      const status = action === "p" ? "paused" : "active";
      await db.from("subscriptions").update({ status }).eq("id", sub.id);
      sub.status = status;
      await answerCallback(BOT_TOKEN, cq.id, status === "paused" ? "Muted" : "Unmuted");
      return renderItem(sub, chatId, messageId);
    }
    case "r":
      await answerCallback(BOT_TOKEN, cq.id);
      return editMessage(BOT_TOKEN, chatId, messageId,
        `Stop tracking ${sub.tracked_products.title}?`,
        { keyboard: confirmRemoveKeyboard(sub.id) });
    case "R": {
      await db.from("subscriptions").delete().eq("id", sub.id);
      await retireIfOrphaned(sub.tracked_products.id);
      await answerCallback(BOT_TOKEN, cq.id, "Removed");
      return renderList(user, chatId, messageId);
    }
    default:
      return answerCallback(BOT_TOKEN, cq.id);
  }
}

/** The ownership check every callback depends on. */
async function ownedSub(userId, subId) {
  const { data } = await db
    .from("subscriptions")
    .select("id, status, target_price, last_alert_price, variant_id, variant_label, interval_minutes, tracked_products(id, url, title, adapter, fetch_strategy, currency, market, variant_selector, check_interval_minutes)")
    .eq("id", subId)
    .eq("user_id", userId)
    .maybeSingle();
  return data ?? null;
}

async function renderList(user, chatId, messageId, cqId) {
  if (cqId) await answerCallback(BOT_TOKEN, cqId);
  const subs = await subscriptionList(user.id);
  if (!subs.length) {
    return editMessage(BOT_TOKEN, chatId, messageId, "Your list is empty — paste a product link to start tracking.");
  }
  const lines = subs.map((s, i) => `${i + 1}. ${s.tracked_products.title}`);
  return editMessage(BOT_TOKEN, chatId, messageId,
    `Tracking ${subs.length} item${subs.length > 1 ? "s" : ""} — tap a number to change one:\n\n${lines.join("\n")}`,
    { keyboard: listKeyboard(subs) });
}

/** The most recent reading's variants for a product (id/label/state/etc.). */
async function latestVariants(productId) {
  const { data } = await db.from("product_readings")
    .select("variants").eq("product_id", productId)
    .order("checked_at", { ascending: false }).limit(1);
  return (data?.[0]?.variants ?? []).filter((v) => v && v.label);
}

async function renderItem(sub, chatId, messageId, cqId) {
  if (cqId) await answerCallback(BOT_TOKEN, cqId);
  const p = sub.tracked_products;
  // SAME SHAPE AS /list: title, an indented detail line, a blank line, the URL.
  // The card used to run title and details together and drop the price entirely,
  // so tapping an item made it look like a different, thinner object than the
  // one in the list you tapped it from.
  const bits = [];
  if (sub.last_alert_price != null) bits.push(`now ${fmt(Number(sub.last_alert_price), p.currency)}`);
  if (sub.target_price != null) bits.push(`target ${fmt(Number(sub.target_price), p.currency)}`);
  bits.push(sub.variant_label ? `size ${sub.variant_label}` : "every size");
  bits.push(`every ${intervalWord(sub.interval_minutes ?? FREE_INTERVAL_MIN)}`);
  if (p.market) bits.push(`${p.market} storefront`);
  if (sub.status === "paused") bits.push("paused");
  if (p.fetch_strategy === "unblocker") bits.push("daily/your key");

  // Nothing to pick on a single-option item, so don't offer the Size button.
  const showSize = (await latestVariants(p.id)).length > 1;
  const text = `${displayTitle(p)}\n   ${bits.join(" · ")}\n\n${p.url}`;
  return editMessage(BOT_TOKEN, chatId, messageId, text,
    { keyboard: itemKeyboard(sub.id, { showSize, showMarket: marketIsChangeable(p) }) });
}

/** The point of the whole feature: pick from what the shop ACTUALLY offers.
 *  Colours first when there's more than one — otherwise a multi-colour item
 *  becomes a wall of identical-looking "colour X / size …" buttons. */
async function renderSizes(sub, chatId, messageId, cqId) {
  const p = sub.tracked_products;
  const variants = await latestVariants(p.id);

  if (variants.length <= 1) {
    await answerCallback(BOT_TOKEN, cqId,
      variants.length ? "This item has just one option — nothing to pick." : "I haven't read this one yet — try again after the next check.");
    return renderItem(sub, chatId, messageId);
  }
  await answerCallback(BOT_TOKEN, cqId);

  if (variantColours(variants).length > 1) {
    return editMessage(BOT_TOKEN, chatId, messageId,
      `🎨 Which colour of ${p.title}?`,
      { keyboard: colourKeyboard(sub.id, variants, sub.variant_id) });
  }
  return editMessage(BOT_TOKEN, chatId, messageId,
    `📏 Which size of ${p.title}?\n✖️ = sold out right now (still worth watching — that's the point).`,
    { keyboard: sizeKeyboard(sub.id, variants, sub.variant_id) });
}

/** The sizes of one colour, reached from the colour picker. */
async function renderSizesForColour(sub, chatId, messageId, cqId, colorCode) {
  const p = sub.tracked_products;
  const variants = (await latestVariants(p.id)).filter((v) => String(v.colorCode) === String(colorCode));
  if (!variants.length) {
    await answerCallback(BOT_TOKEN, cqId, "That colour isn't listed any more.");
    return renderSizes(sub, chatId, messageId, cqId);
  }
  await answerCallback(BOT_TOKEN, cqId);
  return editMessage(BOT_TOKEN, chatId, messageId,
    `📏 colour ${colorCode} — which size?\n✖️ = sold out right now (still worth watching).`,
    { keyboard: sizeKeyboard(sub.id, variants, sub.variant_id, { back: `s:${sub.id}`, includeAny: false }) });
}

async function applySize(sub, chatId, messageId, cqId, variantId) {
  const p = sub.tracked_products;

  if (variantId === "*") {
    await db.from("subscriptions")
      .update({ variant_id: null, variant_label: null, last_alert_status: null, last_alert_price: null })
      .eq("id", sub.id);
    sub.variant_id = null; sub.variant_label = null;
    await answerCallback(BOT_TOKEN, cqId, "Watching every size");
    await bringCheckForward(p.id);
    return renderItem(sub, chatId, messageId);
  }

  const { data: rows } = await db.from("product_readings")
    .select("variants").eq("product_id", p.id)
    .order("checked_at", { ascending: false }).limit(1);
  const hit = (rows?.[0]?.variants ?? []).find((v) => String(v.id) === String(variantId));
  if (!hit) {
    await answerCallback(BOT_TOKEN, cqId, "That size isn't listed any more.");
    return renderSizes(sub, chatId, messageId, cqId);
  }

  // Clearing the dedup state re-baselines on the chosen size, so the next check
  // reports where THAT size stands instead of staying quiet.
  await db.from("subscriptions")
    .update({ variant_id: String(hit.id), variant_label: hit.label, last_alert_status: null, last_alert_price: null })
    .eq("id", sub.id);
  sub.variant_id = String(hit.id); sub.variant_label = hit.label;

  await answerCallback(BOT_TOKEN, cqId, `Watching ${hit.label}`);
  await bringCheckForward(p.id);
  return renderItem(sub, chatId, messageId);
}

async function applyEvery(sub, chatId, messageId, cqId, value) {
  const minutes = INTERVAL_OPTIONS[value];
  const p = sub.tracked_products;
  if (!minutes) return answerCallback(BOT_TOKEN, cqId);

  const floorMin = defendedFloor(p);
  if (minutes < floorMin) {
    return answerCallback(BOT_TOKEN, cqId,
      `This shop costs enough that I keep it to every ${intervalWord(floorMin)} — it's your own credits.`, true);
  }
  await db.from("subscriptions").update({ interval_minutes: minutes }).eq("id", sub.id);
  sub.interval_minutes = minutes;

  const { data: all } = await db.from("subscriptions")
    .select("interval_minutes").eq("product_id", p.id).eq("status", "active");
  const effective = Math.max(MIN_INTERVAL_MIN,
    Math.min(...(all ?? []).map((x) => x.interval_minutes ?? FREE_INTERVAL_MIN), FREE_INTERVAL_MIN));
  await db.from("tracked_products").update({ check_interval_minutes: effective }).eq("id", p.id);

  await answerCallback(BOT_TOKEN, cqId, `Every ${value}`);
  return renderItem(sub, chatId, messageId);
}


// ── market: which storefront is this item watched on? ───────────────────────
//
// A shop's price AND its per-size stock differ by market. Measured on
// mutimer.co, size S, same URL and the same variant id: 240.00 and IN STOCK on
// the UK storefront, 418.00 and SOLD OUT on the Singapore one. So the market is
// part of what you are watching, not a way of displaying it — which is why
// tracked_products is keyed (url, market), and why changing the market REPOINTS
// the subscription at a different row instead of editing this one. Two people
// watching two storefronts are watching two different offers and their
// histories must not mix.

/**
 * Can a market pin actually change what we READ for this item?
 *
 * Only Shopify honours ?country=, and only when the link doesn't already name a
 * storefront of its own. Everywhere else the market is decided by the URL —
 * uniqlo.com/sg/en, farfetch.com/sg, castlery.com/sg — and pinning one would
 * have changed nothing about the fetch while still writing a currency onto the
 * row. That is a control that doesn't control anything, attached to a label that
 * could go wrong: moving a uniqlo.com/sg item to "UK" would have stored GBP
 * against a page that quotes SGD.
 *
 * So the button appears where we can honour it, and the typed path explains
 * itself where we can't. To watch a locale-in-the-URL shop somewhere else, paste
 * that storefront's link — it's a different page, and saying so is honest.
 */
function marketIsChangeable(p) {
  return p?.adapter === "shopify" && !localeFromUrl(p?.url ?? "").country;
}

/** The account default, always on the board even when it isn't shortlisted —
 *  otherwise someone shopping from a country we didn't list sees their own
 *  setting nowhere. */
function marketChoicesFor(user) {
  const cc = user?.settings?.country ? String(user.settings.country).toUpperCase() : "";
  if (!cc || MARKET_CHOICES.some(([c]) => c === cc)) return MARKET_CHOICES;
  return [...MARKET_CHOICES, [cc, cc]];
}


/**
 * What currency will this shop ACTUALLY quote if we pin it to that market?
 *
 * Never assume currencyForCountry() is the answer. A Shopify shop with no market
 * for your country serves its home market instead, silently — mutimer.co answers
 * ?country=IN with 380.00 AUD, and labelling that "INR 380" is wrong by about
 * 25x. So we ask the shop once, at pin time, and store what it says.
 *
 * Returns the currency to store plus a line to show the user when the shop
 * doesn't have a market where they are. Unknown (shop unreachable) keeps the
 * expected currency rather than inventing one — the checker's own reading and
 * the verifier both re-examine it later.
 */
async function resolveMarketCurrency(url, market, adapter) {
  const expected = currencyForCountry(market);
  if (adapter !== "shopify") return { currency: expected ?? null, note: null };
  const probe = await probeMarketCurrency(url, market);
  if (!probe.currency) return { currency: expected ?? null, note: null };
  if (probe.honoured) return { currency: probe.currency, note: null };
  return {
    currency: probe.currency,
    note: `This shop has no ${market} storefront — it serves ${probe.currency} to shoppers there, `
        + `so that's what I'll track. The price is real; it just isn't in ${expected ?? "your currency"}.`,
  };
}

/** The row for this URL at that market, created if nobody watches it yet. */
async function productForMarket(from, market) {
  const { data: existing } = await db.from("tracked_products").select("*")
    .eq("url", from.url).eq("market", market).maybeSingle();
  if (existing) {
    // It may have been retired when its last watcher left; bring it back rather
    // than leaving a subscription pointed at a row the checker skips.
    if (existing.status === "dead") {
      await db.from("tracked_products")
        .update({ status: "active", next_check_at: new Date().toISOString() })
        .eq("id", existing.id);
      existing.status = "active";
    }
    return existing;
  }
  // Belt and braces: adapter is NOT NULL with no default, so a partial row here
  // is a 500 rather than a message. Fail loudly and locally instead.
  if (!from?.url || !from?.adapter) {
    throw new Error(`productForMarket: incomplete product row (url=${from?.url}, adapter=${from?.adapter})`);
  }
  const resolved = await resolveMarketCurrency(from.url, market, from.adapter);
  const { data, error } = await db.from("tracked_products").insert({
    url: from.url,
    market,
    currency: resolved.currency,
    adapter: from.adapter,
    fetch_strategy: from.fetch_strategy,
    title: from.title,
    variant_selector: from.variant_selector,
    check_interval_minutes: from.check_interval_minutes,
    next_check_at: new Date().toISOString(),
  }).select("*").single();
  if (error) throw error;
  data.marketNote = resolved.note;   // surfaced once, by the caller that pinned it
  return data;
}

/**
 * Move a subscription to another market.
 *
 * The baseline is CLEARED, deliberately. A history in AUD and a history in SGD
 * are not one series, and joining them is exactly what sent two fabricated
 * alerts on 2026-09-01 — "SGD 380.00 -> SGD 418.00 (+10%)", a figure that had
 * never existed. Starting again and saying so is the honest option.
 *
 * variant_id survives: Shopify variant ids are stable across markets (verified
 * on mutimer.co — all six sizes keep their ids from SG to GB), and if a variant
 * really has gone the existing unmatched-size path picks it up.
 */
async function moveToMarket(sub, market) {
  const from = sub.tracked_products;
  const target = await productForMarket(from, market);
  await db.from("subscriptions").update({
    product_id: target.id,
    last_alert_price: null,
    last_alert_currency: null,
    last_alert_status: null,
  }).eq("id", sub.id);
  if (target.id !== from.id) await retireIfOrphaned(from.id);
  sub.product_id = target.id;
  sub.tracked_products = target;
  sub.last_alert_price = null;
  sub.last_alert_status = null;
  return target;
}

const marketNote = [
  "Price and stock genuinely differ by market, so I start the price history",
  "again rather than compare two currencies as though they were one.",
].join("\n");

// THE BUTTONS ARE A SHORTLIST, NOT THE LIMIT. Shipping eight of them without
// ever saying so made eight look like the whole world — which is how someone in
// Türkiye or Malaysia concludes the feature isn't for them. Every message that
// shows the shortlist says this.
const TYPE_ANY = (usage) =>
  `Not listed? Type ${usage} with any two-letter country code — I know ${knownCountries().length} of them.`;

async function renderMarkets(user, sub, chatId, messageId, cqId) {
  if (cqId) await answerCallback(BOT_TOKEN, cqId);
  const p = sub.tracked_products;
  return editMessage(BOT_TOKEN, chatId, messageId, [
    `🌐 Which storefront should I watch ${p.title} on?`,
    "",
    p.market
      ? `Right now: ${p.market}${p.currency ? ` (${p.currency})` : ""}`
      : "Right now: whichever the shop serves me — not pinned to one.",
    "",
    marketNote,
    "",
    TYPE_ANY("/market <number> <code>"),
  ].join("\n"), { keyboard: marketKeyboard(sub.id, p.market, marketChoicesFor(user)) });
}

async function applyMarket(user, sub, chatId, messageId, cqId, cc) {
  const market = String(cc ?? "").toUpperCase();
  if (!isKnownCountry(market)) {
    return answerCallback(BOT_TOKEN, cqId, "I don't know how to price that market.", true);
  }
  if (String(sub.tracked_products.market ?? "") === market) {
    await answerCallback(BOT_TOKEN, cqId, `Already on ${market}.`);
    return renderItem(sub, chatId, messageId);
  }
  const moved = await moveToMarket(sub, market);
  await answerCallback(BOT_TOKEN, cqId, `Now watching the ${market} storefront`);
  // A shop with no market where you are serves its own, silently. Say so rather
  // than quietly tracking a number in a currency the user didn't ask for.
  if (moved.marketNote) await reply(chatId, `🌐 ${moved.marketNote}`);
  return renderItem(sub, chatId, messageId);
}

/** The typed path. Same handler the button uses — see commands.mjs on why a
 *  hidden command is worth keeping. */
async function setMarket(user, chatId, ref, cc) {
  const market = String(cc ?? "").toUpperCase();
  if (!isKnownCountry(market)) {
    return reply(chatId, [
      `I don't know how to price “${cc}” — I can't name its currency, and I won't print a number without one.`,
      "",
      `I do know these ${knownCountries().length}:`,
      knownCountries().join(" "),
    ].join("\n"));
  }
  const subs = await subscriptionList(user.id);
  const n = Number(ref);
  if (!Number.isInteger(n) || n < 1 || n > subs.length) {
    return reply(chatId, `Use the number from /list (1–${subs.length || 0}).`);
  }
  const sub = subs[n - 1];
  const p = sub.tracked_products;
  if (!marketIsChangeable(p)) {
    const own = localeFromUrl(p.url).country;
    return reply(chatId, [
      `I can't move ${displayTitle(p)} to another storefront.`,
      "",
      own
        ? `Its link already names one (${own}), so the page itself decides the price — pinning a market would change the label without changing what I read. To watch a different storefront, paste that shop's ${market} link and I'll track it alongside this one.`
        : "This shop doesn't let me switch storefronts by request — the page serves one price and I read that. Pasting the link for the storefront you want works, if the shop has one.",
    ].join("\n"));
  }
  if (String(p.market ?? "") === market) {
    return reply(chatId, `${p.title} is already watched on the ${market} storefront.`);
  }
  const target = await moveToMarket(sub, market);
  return reply(chatId, [
    `🌐 ${p.title} is now watched on the ${market} storefront${target.currency ? ` (${target.currency})` : ""}.`,
    ...(target.marketNote ? ["", target.marketNote] : []),
    "",
    marketNote,
  ].join("\n"));
}

// ── /prefs → where you shop ─────────────────────────────────────────────────
// The ACCOUNT default, which is the weakest of the three signals by design:
// a link that names its own country keeps it, and a per-item pin beats both.

async function showPrefsCountry(user, chatId, messageId, cqId) {
  await answerCallback(BOT_TOKEN, cqId);
  const set = user.settings?.country ? String(user.settings.country).toUpperCase() : "";
  const current = set || (await shopperCountry(user));
  return editMessage(BOT_TOKEN, chatId, messageId, [
    "🌐 Where do you shop?",
    "",
    current
      ? `Right now: ${current}${set ? "" : " — inferred from your links, not something you set"}`
      : "Not set, and I have no links to infer it from yet.",
    "",
    "This is the default for items you add from here on. A link that already names",
    "a country keeps its own, and anything you've pinned by hand stays pinned.",
    "",
    TYPE_ANY("/setcountry <code>"),
  ].join("\n"), { keyboard: prefsCountryKeyboard(current, marketChoicesFor(user)) });
}

async function saveCountry(user, market) {
  const settings = { ...(user.settings ?? {}), country: market };
  user.settings = settings;
  await db.from("users").update({ settings }).eq("id", user.id);
}

async function applyDefaultCountry(user, chatId, messageId, cqId, cc) {
  const market = String(cc ?? "").toUpperCase();
  if (!isKnownCountry(market)) {
    return answerCallback(BOT_TOKEN, cqId, "I don't know how to price that market.", true);
  }
  await saveCountry(user, market);
  await answerCallback(BOT_TOKEN, cqId, `Shopping from ${market}`);
  return renderPrefs(user, chatId, messageId);
}

async function setDefaultCountry(user, chatId, cc) {
  const market = String(cc ?? "").toUpperCase();
  if (!isKnownCountry(market)) {
    return reply(chatId, [
      `I don't know how to price “${cc}” — I can't name its currency, and I won't print a number without one.`,
      "",
      `I do know these ${knownCountries().length}:`,
      knownCountries().join(" "),
    ].join("\n"));
  }
  await saveCountry(user, market);
  return reply(chatId, `🌐 Noted — you shop from ${market}. That's the default for new items; anything already on your list keeps the storefront it's on (open /list and tap 🌐 Market to move one).`);
}

async function showTarget(sub, chatId, messageId, cqId) {
  const p = sub.tracked_products;
  const ref = Number(sub.last_alert_price);
  if (!(ref > 0)) {
    // No price to anchor presets to yet — offer the typed escape hatch instead.
    await answerCallback(BOT_TOKEN, cqId, "I haven't read a price yet — try again after the next check.");
    return renderItem(sub, chatId, messageId);
  }
  await answerCallback(BOT_TOKEN, cqId);
  const now = `Last seen at ${ref}.`;
  const line = sub.target_price != null ? `Alerting below ${sub.target_price}.` : "No target set.";
  return editMessage(BOT_TOKEN, chatId, messageId,
    `🎯 Alert me when ${p.title} drops to…\n${now} ${line}`,
    { keyboard: targetKeyboard(sub.id, ref, { hasTarget: sub.target_price != null }) });
}

async function applyTarget(sub, chatId, messageId, cqId, arg) {
  const pct = Number(arg);
  if (pct === 0) {
    await db.from("subscriptions").update({ target_price: null }).eq("id", sub.id);
    sub.target_price = null;
    await answerCallback(BOT_TOKEN, cqId, "Target cleared");
    return renderItem(sub, chatId, messageId);
  }
  const ref = Number(sub.last_alert_price);
  if (!(ref > 0) || !Number.isFinite(pct)) return answerCallback(BOT_TOKEN, cqId);
  // Recompute from the LIVE price, not the number baked into the button, so a
  // stale menu can't set a target off an out-of-date price.
  const target = Math.round(ref * (1 - pct / 100) * 100) / 100;
  await db.from("subscriptions").update({ target_price: target }).eq("id", sub.id);
  sub.target_price = target;
  await answerCallback(BOT_TOKEN, cqId, `Alerting below ${target}`);
  return renderItem(sub, chatId, messageId);
}

async function renderHistory(sub, chatId, messageId, cqId) {
  await answerCallback(BOT_TOKEN, cqId);
  const p = sub.tracked_products;
  const [{ data: stats }, { data: points }] = await Promise.all([
    db.rpc("price_stats", { p_product_id: p.id, p_days: 90 }),
    db.rpc("price_history", { p_product_id: p.id, p_days: 90 }),
  ]);
  return editMessage(BOT_TOKEN, chatId, messageId,
    formatHistory(p, Array.isArray(stats) ? stats[0] : stats, points ?? [], 90),
    { keyboard: backToItemKeyboard(sub.id) });
}

/** A size change should be answered by the next tick, not in six hours. */
const bringCheckForward = (productId) =>
  db.from("tracked_products").update({ next_check_at: new Date().toISOString() }).eq("id", productId);

/**
 * Tell someone what a bot-protected item will cost BEFORE they commit to it.
 * Free stores say nothing — there's nothing to spend.
 */
async function costNote(user, plan, product) {
  if (plan.strategy !== "unblocker") return [];

  const tier = product.unblocker_tier ?? ADAPTER_TIER[plan.adapter] ?? "render";
  const interval = product.check_interval_minutes ?? TIER_INTERVAL_MIN[tier] ?? DEFENDED_INTERVAL_MIN;
  const cost = monthlyCredits(tier, interval);

  const { data: key } = await db.from("user_api_keys")
    .select("credits_remaining").eq("user_id", user.id).maybeSingle();

  // Sum what everything else on their list is already committed to.
  const { data: rows } = await db
    .from("subscriptions")
    .select("interval_minutes, tracked_products(adapter, fetch_strategy, unblocker_tier, check_interval_minutes)")
    .eq("user_id", user.id).eq("status", "active");
  const committed = (rows ?? [])
    .filter((r) => r.tracked_products?.fetch_strategy === "unblocker")
    .reduce((n, r) => {
      const p = r.tracked_products;
      const t = p.unblocker_tier ?? ADAPTER_TIER[p.adapter] ?? "render";
      return n + monthlyCredits(t, r.interval_minutes ?? p.check_interval_minutes ?? DEFENDED_INTERVAL_MIN);
    }, 0);

  const line = `💳 About ${cost} credits/month on your key.`;
  return key?.credits_remaining != null
    ? [`${line} Your list now commits ~${committed}/month, and you have ${key.credits_remaining} left.`]
    : [line];
}
