import { execFileSync } from 'child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// --- Mocks (hoisted so they are in place before imports resolve) ---

// vi.hoisted ensures this runs before vi.mock factory closures.
const { mockExistsSync } = vi.hoisted(() => ({
  mockExistsSync: vi.fn(() => true),
}));

vi.mock('better-sqlite3');
vi.mock('child_process', () => ({ execFileSync: vi.fn() }));

// Mock fs.existsSync so we can control whether chat.db "exists".
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: mockExistsSync,
    },
  };
});

// Mock sender-allowlist to return permissive defaults.
vi.mock('../sender-allowlist.js', () => ({
  loadSenderAllowlist: vi.fn(() => ({
    default: { allow: '*', mode: 'trigger' },
    chats: {},
    logDenied: false,
  })),
  isTriggerAllowed: vi.fn(() => true),
}));

// Mock logger to suppress output during tests.
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

// Mock config to use a short poll interval.
vi.mock('../config.js', () => ({ POLL_INTERVAL: 100 }));

import Database from 'better-sqlite3';
import { isTriggerAllowed } from '../sender-allowlist.js';

import {
  appleNanosToDate,
  createIMessageChannel,
  IMessageChannel,
} from './imessage.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOpts() {
  const onMessage = vi.fn();
  const onChatMetadata = vi.fn();
  const registeredGroups = vi.fn(() => ({}));
  return { onMessage, onChatMetadata, registeredGroups };
}

/** Build a fake better-sqlite3 Database instance. */
function makeFakeDb(rows: object[] = []) {
  const preparedStmt = {
    all: vi.fn(() => rows),
    get: vi.fn(() => ({ maxRowid: 0 })),
  };
  const db = {
    prepare: vi.fn(() => preparedStmt),
    close: vi.fn(),
    _stmt: preparedStmt,
  };
  return db;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('appleNanosToDate', () => {
  it('converts Apple epoch nanoseconds to the correct JS Date', () => {
    // 0 nanoseconds = 2001-01-01T00:00:00.000Z
    expect(appleNanosToDate(0).toISOString()).toBe('2001-01-01T00:00:00.000Z');
  });

  it('handles a realistic timestamp', () => {
    // 1_000_000_000 ns = 1 second after Apple epoch
    const d = appleNanosToDate(1_000_000_000);
    expect(d.toISOString()).toBe('2001-01-01T00:00:01.000Z');
  });

  it('handles large values (year 2024)', () => {
    // Verify the offset math doesn't overflow for a real-world value.
    // 2024-01-01T00:00:00Z = Unix ms 1704067200000
    // Apple ns = (1704067200000 - 978307200000) * 1e6 = 725760000000 * 1e6
    const unixMs = 1704067200000;
    const appleNs = (unixMs - 978307200000) * 1_000_000;
    expect(appleNanosToDate(appleNs).getTime()).toBe(unixMs);
  });
});

describe('createIMessageChannel factory', () => {
  it('returns null when chat.db does not exist', () => {
    mockExistsSync.mockReturnValueOnce(false);
    const channel = createIMessageChannel(makeOpts());
    expect(channel).toBeNull();
  });

  it('returns an IMessageChannel when chat.db exists', () => {
    mockExistsSync.mockReturnValueOnce(true);
    const channel = createIMessageChannel(makeOpts());
    expect(channel).toBeInstanceOf(IMessageChannel);
  });
});

describe('IMessageChannel', () => {
  let fakeDb: ReturnType<typeof makeFakeDb>;
  let channel: IMessageChannel;
  let opts: ReturnType<typeof makeOpts>;

  beforeEach(() => {
    fakeDb = makeFakeDb();
    vi.mocked(Database).mockImplementation(function () {
      return fakeDb as unknown as Database.Database;
    });
    vi.mocked(isTriggerAllowed).mockReturnValue(true);
    opts = makeOpts();
    channel = new IMessageChannel(opts.onMessage, opts.onChatMetadata);
  });

  afterEach(async () => {
    if (channel.isConnected()) {
      await channel.disconnect();
    }
    vi.clearAllMocks();
  });

  it('connects without throwing', async () => {
    await channel.connect();
    expect(channel.isConnected()).toBe(true);
  });

  it('disconnects and marks as not connected', async () => {
    await channel.connect();
    await channel.disconnect();
    expect(channel.isConnected()).toBe(false);
  });

  it('ownsJid returns true for imessage: prefix', () => {
    expect(channel.ownsJid('imessage:+15551234567')).toBe(true);
    expect(channel.ownsJid('whatsapp:+15551234567')).toBe(false);
  });

  it('polls for new messages and delivers them via onMessage', async () => {
    const appleNs = (1704067200000 - 978307200000) * 1_000_000; // 2024-01-01
    const rows = [
      {
        ROWID: 42,
        guid: 'msg-guid-1',
        text: 'Hello world',
        is_from_me: 0,
        date: appleNs,
        handle_id: '+15551234567',
        chat_identifier: '+15551234567',
      },
    ];

    fakeDb._stmt.all.mockReturnValue(rows);
    await channel.connect();

    // Trigger poll manually.
    await vi.waitUntil(() => opts.onMessage.mock.calls.length > 0, { timeout: 500 });

    expect(opts.onMessage).toHaveBeenCalledOnce();
    const [jid, msg] = opts.onMessage.mock.calls[0] as [string, import('../types.js').NewMessage];
    expect(jid).toBe('imessage:+15551234567');
    expect(msg.content).toBe('Hello world');
    expect(msg.id).toBe('msg-guid-1');
    expect(msg.sender).toBe('+15551234567');
  });

  it('skips messages from non-allowlisted senders', async () => {
    vi.mocked(isTriggerAllowed).mockReturnValue(false);

    const rows = [
      {
        ROWID: 10,
        guid: 'guid-blocked',
        text: 'spam',
        is_from_me: 0,
        date: 0,
        handle_id: '+10000000000',
        chat_identifier: '+10000000000',
      },
    ];
    fakeDb._stmt.all.mockReturnValue(rows);

    await channel.connect();

    // Give poll a chance to run.
    await new Promise((r) => setTimeout(r, 150));

    expect(opts.onMessage).not.toHaveBeenCalled();
  });

  it('advances lastSeenRowid after polling', async () => {
    const rows = [
      {
        ROWID: 99,
        guid: 'g',
        text: 'hi',
        is_from_me: 0,
        date: 0,
        handle_id: '+1',
        chat_identifier: '+1',
      },
    ];

    // First poll returns a message; subsequent polls return nothing.
    fakeDb._stmt.all
      .mockReturnValueOnce(rows)
      .mockReturnValue([]);

    await channel.connect();
    await vi.waitUntil(() => opts.onMessage.mock.calls.length > 0, { timeout: 500 });

    // The second poll should query with ROWID > 99 — all calls after the first should pass 99.
    // Allow one more tick.
    await new Promise((r) => setTimeout(r, 150));
    const calls = fakeDb._stmt.all.mock.calls as unknown[][];
    // First call uses rowid 0 (initial seed), second should use 99.
    expect(calls[1]?.[0]).toBe(99);
  });

  it('sends a message via osascript with correct AppleScript', async () => {
    await channel.sendMessage('imessage:+15559876543', 'Hello there');

    expect(execFileSync).toHaveBeenCalledOnce();
    const [cmd, args] = vi.mocked(execFileSync).mock.calls[0] as [string, string[]];
    expect(cmd).toBe('osascript');
    expect(args[0]).toBe('-e');
    const script = args[1];
    expect(script).toContain('tell application "Messages"');
    expect(script).toContain('buddy "+15559876543"');
    expect(script).toContain('send "Hello there"');
  });

  it('escapes double-quotes in handle and text for AppleScript', async () => {
    await channel.sendMessage('imessage:test"handle', 'say "hi"');

    const [, args] = vi.mocked(execFileSync).mock.calls[0] as [string, string[]];
    const script = args[1];
    expect(script).toContain('buddy "test\\"handle"');
    expect(script).toContain('send "say \\"hi\\""');
  });

  it('calls onChatMetadata for each new message', async () => {
    const rows = [
      {
        ROWID: 1,
        guid: 'g1',
        text: 'hi',
        is_from_me: 0,
        date: 0,
        handle_id: 'alice@example.com',
        chat_identifier: 'alice@example.com',
      },
    ];
    fakeDb._stmt.all.mockReturnValueOnce(rows).mockReturnValue([]);

    await channel.connect();
    await vi.waitUntil(() => opts.onChatMetadata.mock.calls.length > 0, { timeout: 500 });

    expect(opts.onChatMetadata).toHaveBeenCalledWith(
      'imessage:alice@example.com',
      expect.any(String),
      undefined,
      'imessage',
      false,
    );
  });

  it('syncGroups resolves without error', async () => {
    await expect(channel.syncGroups(false)).resolves.toBeUndefined();
  });

  it('handles DB errors during poll gracefully', async () => {
    fakeDb._stmt.all.mockImplementation(() => {
      throw new Error('disk I/O error');
    });

    await channel.connect();
    // Poll runs on interval — just ensure no unhandled rejection after a tick.
    await new Promise((r) => setTimeout(r, 150));
    expect(channel.isConnected()).toBe(true);
  });
});
