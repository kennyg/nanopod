# Intent: src/index.ts modifications for web channel

## What changed
1. **Imports**: Added `STORE_DIR`, `WEB_GATEWAY_PORT`, `WEB_GATEWAY_TOKEN` from config; added `WebChannel` from channels/web
2. **WhatsApp optional**: `whatsapp` typed as `WhatsAppChannel | undefined`; init wrapped in try/catch with `creds.json` existence check so NanoPod can run without WhatsApp configured
3. **Web channel init block**: After WhatsApp, conditionally creates and connects a `WebChannel` when `WEB_GATEWAY_PORT > 0 && WEB_GATEWAY_TOKEN` is set
4. **Auto-register `web:default`**: On first run (no `web:` rooms exist yet), registers a default room so the chat UI works immediately
5. **Types import**: Imports `Channel` and `NewMessage` (no `MessageMetadata` — that's a separate concern)

## Why
The web gateway provides a self-hosted chat UI as an alternative to WhatsApp. Making WhatsApp non-fatal allows NanoPod to operate as a web-only instance.

## Invariants to preserve
- WhatsApp must remain functional when `creds.json` exists — the try/catch is only for graceful degradation
- The `channels` array order doesn't matter (findChannel uses `ownsJid`)
- `syncGroupMetadata` must use optional chaining on `whatsapp` since it may be undefined
- IPC `sendMessage` uses the base Channel interface signature (no metadata parameter)
- The web channel block must come AFTER WhatsApp init but BEFORE `startSchedulerLoop`/`startIpcWatcher`
