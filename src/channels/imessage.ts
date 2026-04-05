import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';

import { POLL_INTERVAL } from '../config.js';
import { logger } from '../logger.js';
import {
  isTriggerAllowed,
  loadSenderAllowlist,
  SenderAllowlistConfig,
} from '../sender-allowlist.js';
import {
  Channel,
  NewMessage,
  OnChatMetadata,
  OnInboundMessage,
} from '../types.js';
import { ChannelOpts, registerChannel } from './registry.js';

// Inspired by the official Claude iMessage plugin:
// https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/imessage

// Apple's CoreData epoch starts 2001-01-01; Unix epoch starts 1970-01-01.
// Difference = 978307200 seconds = 978307200000 ms.
// Messages dates are stored as nanoseconds since the Apple epoch.
const APPLE_EPOCH_OFFSET_MS = 978307200000;

export function appleNanosToDate(appleNanos: number): Date {
  return new Date(APPLE_EPOCH_OFFSET_MS + Math.floor(appleNanos / 1000000));
}

export const CHAT_DB_PATH = path.join(
  os.homedir(),
  'Library',
  'Messages',
  'chat.db',
);

const NEW_MESSAGES_SQL = `
  SELECT
    m.ROWID, m.guid, m.text, m.is_from_me, m.date,
    h.id as handle_id,
    c.chat_identifier
  FROM message m
  JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
  JOIN chat c ON cmj.chat_id = c.ROWID
  LEFT JOIN handle h ON m.handle_id = h.ROWID
  WHERE m.ROWID > ? AND m.is_from_me = 0 AND m.text IS NOT NULL AND m.text != ''
  ORDER BY m.ROWID ASC
`;

interface MessageRow {
  ROWID: number;
  guid: string;
  text: string;
  is_from_me: number;
  date: number;
  handle_id: string | null;
  chat_identifier: string;
}

export class IMessageChannel implements Channel {
  readonly name = 'imessage';

  private db: Database.Database | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastSeenRowid = 0;
  private connected = false;
  private allowlist: SenderAllowlistConfig;

  constructor(
    private readonly onMessage: OnInboundMessage,
    private readonly onChatMetadata: OnChatMetadata,
  ) {
    this.allowlist = loadSenderAllowlist();
  }

  async connect(): Promise<void> {
    try {
      this.db = new Database(CHAT_DB_PATH, { readonly: true });
    } catch (err) {
      logger.warn(
        { err },
        'imessage: failed to open chat.db — grant Full Disk Access to this ' +
          'process in System Settings > Privacy & Security > Full Disk Access, then restart',
      );
      return;
    }

    // Seed lastSeenRowid so we only deliver messages that arrive after startup.
    const row = this.db
      .prepare('SELECT MAX(ROWID) as maxRowid FROM message')
      .get() as { maxRowid: number | null } | undefined;
    this.lastSeenRowid = row?.maxRowid ?? 0;

    this.connected = true;
    logger.info({ lastSeenRowid: this.lastSeenRowid }, 'imessage: connected');

    this.pollTimer = setInterval(() => {
      this.poll();
    }, POLL_INTERVAL);
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    logger.info('imessage: disconnected');
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('imessage:');
  }

  // iMessage has no concept of syncing group membership from the platform.
  async syncGroups(_force: boolean): Promise<void> {}

  async sendMessage(jid: string, text: string): Promise<void> {
    // jid format: imessage:<handle>
    const handle = jid.startsWith('imessage:')
      ? jid.slice('imessage:'.length)
      : jid;

    // Escape backslashes and double-quotes for the AppleScript string literal.
    const escapedHandle = handle.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const escapedText = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

    const script = [
      'tell application "Messages"',
      '  set targetService to 1st service whose service type = iMessage',
      `  set targetBuddy to buddy "${escapedHandle}" of targetService`,
      `  send "${escapedText}" to targetBuddy`,
      'end tell',
    ].join('\n');

    execFileSync('osascript', ['-e', script]);
  }

  private poll(): void {
    if (!this.db) return;

    let rows: MessageRow[];
    try {
      rows = this.db
        .prepare(NEW_MESSAGES_SQL)
        .all(this.lastSeenRowid) as MessageRow[];
    } catch (err) {
      logger.warn({ err }, 'imessage: poll query failed');
      return;
    }

    for (const row of rows) {
      this.lastSeenRowid = row.ROWID;
      this.handleRow(row);
    }
  }

  private handleRow(row: MessageRow): void {
    const handle = row.handle_id ?? row.chat_identifier;
    const jid = `imessage:${handle}`;

    if (!isTriggerAllowed(jid, handle, this.allowlist)) {
      return;
    }

    const timestamp = appleNanosToDate(row.date).toISOString();

    this.onChatMetadata(jid, timestamp, undefined, 'imessage', false);

    const message: NewMessage = {
      id: row.guid,
      chat_jid: jid,
      sender: handle,
      sender_name: handle,
      content: row.text,
      timestamp,
    };

    this.onMessage(jid, message);
  }
}

export function createIMessageChannel(
  opts: ChannelOpts,
): IMessageChannel | null {
  if (!fs.existsSync(CHAT_DB_PATH)) {
    logger.debug(
      { path: CHAT_DB_PATH },
      'imessage: chat.db not found — skipping channel (non-macOS or Messages not set up)',
    );
    return null;
  }

  return new IMessageChannel(opts.onMessage, opts.onChatMetadata);
}

registerChannel('imessage', createIMessageChannel);
