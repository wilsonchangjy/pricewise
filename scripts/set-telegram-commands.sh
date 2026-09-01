#!/usr/bin/env bash
# Register everything about the bot that lives on TELEGRAM'S servers rather than
# in this repo: the slash-command menu ("/" autocomplete + the ☰ button), and the
# profile text people read before they ever send a message.
#
# WHY THIS EXISTS: none of this is in the Edge Function code, so trimming /help or
# removing a command from the router does NOT change what Telegram shows. It has
# drifted twice now — the menu still listed /pause and /resume months after they
# were retired, and the description still said "paste a product link to start"
# after the bot had learned to find items from a description. Both were invisible
# from the repo. This script is the single source of truth; re-run it whenever the
# commands or the pitch change.
#
# The MENU is intentionally minimal — the tap-first item card (open via /list)
# carries the per-item actions. Commands NOT listed here (/size, /every,
# /setprice, /history, /remove, /setsize, /setevery, /providers, /market,
# /setcountry) still WORK when typed; they're just not advertised. Each costs a
# parse case and a one-line switch arm — the handler is the same one the button
# calls — so keeping them is close to free. /pause and /resume are retired entirely.
#
# Usage:  TELEGRAM_BOT_TOKEN=... ./scripts/set-telegram-commands.sh
#         (or run from the repo root with the token exported / in your .env)
set -euo pipefail

: "${TELEGRAM_BOT_TOKEN:?Set TELEGRAM_BOT_TOKEN (export it or source your .env first)}"

read -r -d '' COMMANDS <<'JSON' || true
[
  {"command": "list",   "description": "Your items — tap one to change it"},
  {"command": "stores", "description": "Which shops I can track"},
  {"command": "prefs",  "description": "Your defaults, limits & unblocker credits"},
  {"command": "setkey", "description": "Add your own unblocker key"},
  {"command": "setaikey", "description": "Add a model key so I can search the web"},
  {"command": "help",   "description": "How this works"}
]
JSON

# Register on BOTH the private-chat scope and the DEFAULT scope. The default was
# left empty once, and while iOS read the private-chat scope happily, a client
# that falls back to the default saw no commands — and the ☰ Menu button is
# populated from whichever scope the client resolves.
for SCOPE in '"scope": {"type": "all_private_chats"},' ''; do
  echo "Registering commands (${SCOPE:-default scope})…"
  curl -sS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setMyCommands" \
    -H "Content-Type: application/json" \
    -d "{${SCOPE} \"commands\": ${COMMANDS}}"
  echo
done

# The ☰ Menu button next to the message box. "commands" makes it list the above;
# it's Telegram's default, but pin it so a stray BotFather change can't drop it.
echo "Pinning the menu button to the command list…"
curl -sS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setChatMenuButton" \
  -H "Content-Type: application/json" -d '{"menu_button":{"type":"commands"}}'
echo

# The profile text. `description` is the empty-chat screen someone sees BEFORE
# they send anything — the only pitch a new user gets — and `short_description`
# is the one-liner on the bot's profile card and in search results. Both cap at
# 512 chars; keep them to what the bot actually does today.
echo "Setting the description (shown on the empty-chat screen)…"
curl -sS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setMyDescription" \
  -H "Content-Type: application/json" -d @- <<'JSON'
{"description": "I watch the clothes you're eyeing and message you when your size comes back in stock or the price drops.\n\nPaste a product link to start — or just describe what you're after (\"Our Legacy Camion boots in black\") and I'll go and find it."}
JSON
echo

echo "Setting the short description (profile card and search results)…"
curl -sS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setMyShortDescription" \
  -H "Content-Type: application/json" -d @- <<'JSON'
{"short_description": "Open-source price and per-size stock tracker. Paste a link, or describe the item."}
JSON
echo

# Read it all back, so a run is self-verifying rather than hopeful.
echo "Now live:"
curl -sS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMyCommands" \
  -H "Content-Type: application/json" -d '{"scope":{"type":"all_private_chats"}}'
echo
curl -sS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMyDescription"; echo
curl -sS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMyShortDescription"; echo
