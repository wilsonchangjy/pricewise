# Pricewise Phase 1 — setup (your side)

What **you** do vs. what **I** build. Nothing here needs the unblocker/credits —
defended sites are opt-in per user (their own key).

## ✅ You can do now (unblocks the rest)

1. **Create a Supabase project** (free tier) at supabase.com → note the project
   URL and the **service_role** key (Settings → API).
2. **Apply the schema** — run **every** file in `supabase/migrations/` in filename
   order, from `0001_init.sql` through the highest-numbered one. (Or `supabase link`
   + `supabase db push` if you use the CLI, which does the same thing.) Don't stop
   partway: later migrations add the vault key storage, retention, health checks and
   currency columns the Edge Functions expect, and a half-applied schema fails at
   runtime rather than at apply time.
3. **Enable extensions** (Database → Extensions): `pg_cron`, and `pgsodium` **or**
   Vault (for encrypting users' ScrapingBee keys).
4. **Bot:** reuse the existing @BotFather bot, or make a fresh one for the public
   build → note the token. Then run
   `TELEGRAM_BOT_TOKEN=… ./scripts/set-telegram-commands.sh`, which registers the
   slash-command menu **and** the bot's description and short description. All of
   that lives on Telegram's servers, not in the code, so it's the part a code
   deploy will never update — re-run the script whenever the commands or the pitch
   change. (It has drifted twice: a retired command lingering in the menu, and a
   description that no longer matched what the bot could do.)
5. **Public repo (optional now):** create an empty GitHub repo. When the code's
   ready I'll extract `phase1/` into it (clean history, MIT license) — nothing
   personal is in the code.

## ⏳ I build next (code)

- Port the 12 Phase 0 adapters to Deno (they're pure ESM — near-copy).
- **`webhook` Edge Function** — validates the Telegram secret header, parses the
  message (`src/commands.mjs`), applies the credit policy (`src/policy.mjs`),
  reads/writes Supabase, deletes `/setkey` messages, replies.
- **`checker` Edge Function** — `claim_due_products()` → read via the adapter
  (decrypting the user's key for defended) → diff → alert → write readings.

## ⏳ You deploy (once I hand off the functions)

6. `supabase functions deploy webhook checker`
7. **Secrets:** `supabase secrets set TELEGRAM_BOT_TOKEN=… TELEGRAM_WEBHOOK_SECRET=<random>`
   (no global `UNBLOCKER_KEY` — users bring their own, and the same goes for the
   model key behind describe-an-item search: it's per-user via `/setaikey`, stored
   in Vault, so the deployment holds no model credentials at all).

   Two optional overrides, if you want a different model than the defaults:
   `AI_MODEL_ANTHROPIC` (default `claude-opus-5`) and `AI_MODEL_OPENAI`
   (default `gpt-5`). Neither is required — search works without setting either.
8. **Register the webhook:**
   `curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<project>.functions.supabase.co/webhook&secret_token=<TELEGRAM_WEBHOOK_SECRET>"`
9. **Schedule the checker** (SQL editor):
   `select cron.schedule('pricewise-checker','*/15 * * * *', $$select net.http_post('https://<project>.functions.supabase.co/checker', '{}', 'application/json')$$);`
10. **Allowlist yourself** (then friends): `update users set is_allowed = true where telegram_user_id = <you>;`
    (a row is created the first time you message the bot).

## Rollout
Start with yourself + a few friends (`is_allowed`), watch `site_requests` for
demand, and keep defended usage on BYO-keys. Migrate your Phase 0 list by
`/add`-ing the URLs, or a one-off seed script.
