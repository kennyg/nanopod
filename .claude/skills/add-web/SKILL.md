# /add-web — Self-hosted Web Chat UI

Adds a web-based chat interface with real-time SSE updates. No external dependencies — uses Node.js built-in `http` and `crypto` modules.

## Prerequisites

- NanoPod core installed and building (`npm run build` succeeds)
- At least one group registered (or web:default will be auto-created)

## Setup Workflow

### Phase 1: Pre-flight

Check if web channel is already installed:
```bash
grep -q 'WEB_GATEWAY_PORT' .env 2>/dev/null && echo "Already configured" || echo "Not configured"
```

Check skill state:
```bash
cat .nanopod/state.yaml 2>/dev/null | grep web || echo "Not installed"
```

Ask user for preferred port (default: 8080).

### Phase 2: Apply Code

Apply the skill:
```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-web
```

Verify build and tests pass:
```bash
npm run build
npx vitest run src/channels/web.test.ts
```

### Phase 3: Configure Environment

Generate a secure token and set environment variables:
```bash
# Generate token
TOKEN=$(openssl rand -hex 24)

# Add to .env
echo "" >> .env
echo "# Web gateway" >> .env
echo "WEB_GATEWAY_PORT=8080" >> .env
echo "WEB_GATEWAY_TOKEN=$TOKEN" >> .env

# Sync to container env
cp .env data/env/env
```

Print the token for the user to save.

### Phase 4: Build & Restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanopod
```

### Phase 5: Verify

Open the web UI and confirm it works:
```
http://localhost:8080/?token=<your-token>
```

1. The room list page should load with a "Web Chat" room
2. Click into the room, send a test message
3. The bot should respond (requires an agent container to be available)

## What Gets Added

| File | Purpose |
|------|---------|
| `src/channels/web.ts` | HTTP server, SSE, room management, message routing |
| `src/channels/web-ui.ts` | Self-contained HTML/CSS/JS chat UI (no build step) |
| `src/channels/web.test.ts` | 17 integration tests |
| `config-examples/nginx-web-gateway.conf` | Reverse proxy config for TLS/SSE |

## What Gets Modified

| File | Changes |
|------|---------|
| `src/config.ts` | Adds `WEB_GATEWAY_PORT` and `WEB_GATEWAY_TOKEN` exports |
| `src/index.ts` | WebChannel init, WhatsApp made non-fatal, auto-register web:default |
| `src/db.ts` | Adds `getRecentMessages()` and `storeMessageDirect()` |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `WEB_GATEWAY_PORT` | `0` (disabled) | Port for the web gateway HTTP server |
| `WEB_GATEWAY_TOKEN` | empty (disabled) | Bearer token for authentication |

Both must be set for the web channel to start. Port=0 or empty token = disabled.

## Security Notes

- Token auth on all routes (query param or Bearer header)
- No external network exposure by default (localhost only)
- Use the nginx config example if you need TLS or remote access via Tailscale
- Token is generated with `openssl rand -hex 24` (48 hex chars / 192 bits)
