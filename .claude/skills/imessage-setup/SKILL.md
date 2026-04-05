---
name: imessage-setup
description: Set up and configure the iMessage channel. Verifies Full Disk Access, registers iMessage contacts as NanoPod groups, and manages the sender allowlist.
---

# iMessage Setup

Run `/imessage-setup` to configure the iMessage channel after first run.

## What it does

1. Verifies Full Disk Access to `~/Library/Messages/chat.db`
2. Shows iMessage contacts who have already messaged this Mac
3. Registers selected contacts as NanoPod groups
4. Optionally configures the sender allowlist

---

# Step 1: Check Full Disk Access

```bash
ls ~/Library/Messages/chat.db 2>&1
```

If "Operation not permitted": tell the user to go to **System Settings → Privacy & Security → Full Disk Access** and add their terminal app, then restart NanoPod.

If the file exists: proceed.

# Step 2: Find iMessage contacts who have messaged

Query the NanoPod chats table for iMessage JIDs seen so far:

```bash
sqlite3 store/messages.db "SELECT jid, name FROM chats WHERE jid LIKE 'imessage:%' ORDER BY last_message_time DESC;"
```

If no rows: tell the user to send a message to themselves first (open Messages, send to your own number/Apple ID), then re-run.

Show the list to the user and ask via AskUserQuestion which contacts to register as groups. Include an option for each JID plus "All of the above" and "None — I'll do this later".

# Step 3: Register selected contacts as groups

For each selected JID (e.g. `imessage:+15551234567`):

1. Derive a folder name: strip `imessage:` prefix, replace non-alphanumeric with `-`, lowercase. E.g. `imessage-15551234567`.
2. Ask for a display name (default: the handle itself).
3. Insert into the DB:

```bash
sqlite3 store/messages.db "INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger, added_at, requires_trigger) VALUES ('<jid>', '<name>', '<folder>', '@Andy', datetime('now'), 0);"
```

4. Create the group folder if it doesn't exist:
```bash
mkdir -p groups/<folder>
```

After registering, tell the user to restart NanoPod (`npm run dev`) for the changes to take effect.

# Step 4: Allowlist (optional)

Ask via AskUserQuestion: "Who should be able to trigger Andy via iMessage?"
- **Only myself** (self-chat) — default, no changes needed
- **Specific contacts** — add handles to the allowlist
- **Anyone** — already the default (`allow: "*"`)

If "Specific contacts": for each handle, add to `store/sender-allowlist.json`:

```json
{
  "default": { "allow": ["<handle1>", "<handle2>"], "mode": "trigger" },
  "chats": {},
  "logDenied": true
}
```

Check if `store/sender-allowlist.json` already exists and merge rather than overwrite.

# Step 5: Summary

Show:
- Groups registered (list JIDs and folders)
- Allowlist policy
- Next step: restart NanoPod and send `@Andy hello` to test
