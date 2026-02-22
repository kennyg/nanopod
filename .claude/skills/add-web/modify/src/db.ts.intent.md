# Intent: src/db.ts modifications for web channel

## What changed
- Added `getRecentMessages(chatJid, limit?)` function

## Why
The web channel needs to retrieve full conversation history including bot messages for the chat UI. `getRecentMessages` returns the last N messages ordered chronologically, including both user and bot messages. (The web channel also uses `storeMessageDirect` which already exists in the base.)

## Invariants to preserve
- `getRecentMessages` must return messages in chronological order (oldest first) despite querying DESC + reversing
- `getRecentMessages` includes ALL messages (user + bot) — it does NOT filter by `is_bot_message`
- `storeMessageDirect` uses the same INSERT OR REPLACE pattern as `storeMessage`
- Neither function affects the existing `getNewMessages` or `getMessagesSince` which filter out bot messages
