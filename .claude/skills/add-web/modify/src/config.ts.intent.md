# Intent: src/config.ts modifications for web channel

## What changed
- Added `'WEB_GATEWAY_PORT'` and `'WEB_GATEWAY_TOKEN'` to the `readEnvFile()` keys array
- Added `WEB_GATEWAY_PORT` export (parsed as integer, defaults to `'0'` = disabled)
- Added `WEB_GATEWAY_TOKEN` export (string, defaults to empty = disabled)

## Why
The web gateway channel needs a port to listen on and a bearer token for authentication. Both are read from `.env` / `process.env` following the same pattern as other config values. A port of 0 or empty token means the web channel is disabled.

## Invariants to preserve
- The `readEnvFile` call must include all env keys that the config module exports — new keys must be added to both the array AND the exports
- Web gateway config must remain at the bottom of the file, after the existing exports
- Default values (port=0, token='') must ensure the web channel is OFF unless explicitly configured
