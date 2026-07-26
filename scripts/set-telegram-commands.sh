#!/usr/bin/env bash
# Register the bot's slash-command menu with Telegram (the "/" autocomplete and
# the ☰ menu button).
#
# WHY THIS EXISTS: this list lives on Telegram's servers, set via setMyCommands —
# NOT in the Edge Function code. So trimming the in-chat /help text or removing a
# command from the router does NOT change what Telegram suggests. The two drifted
# once (the menu still showed /pause and /resume long after they were retired).
# This script is the single source of truth; re-run it whenever the set changes.
#
# The MENU is intentionally minimal — the tap-first item card (open via /list)
# carries the per-item actions. Commands NOT listed here (/size, /every,
# /setprice, /history, /remove, /setsize, /setevery, /providers) still WORK when
# typed; they're just not advertised. /pause and /resume are retired entirely.
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

# Show what's now live so a run is self-verifying.
echo "Now registered:"
curl -sS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMyCommands" \
  -H "Content-Type: application/json" -d '{"scope":{"type":"all_private_chats"}}'
echo
