import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _initTestDatabase, getRecentMessages, storeChatMetadata } from '../db.js';
import { RegisteredGroup } from '../types.js';
import { WebChannel, WebChannelOpts } from './web.js';

// Shared test setup
function createOpts(overrides?: Partial<WebChannelOpts>): WebChannelOpts {
  return {
    port: 0, // OS-assigned port
    token: 'test-token-123',
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: () => ({
      'web:default': {
        name: 'Web Chat',
        folder: 'web-default',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
        requiresTrigger: false,
      },
    }),
    ...overrides,
  };
}

function getPort(channel: WebChannel): number {
  // Access the server's assigned port via the internal server
  return (channel as unknown as { server: { address(): { port: number } } }).server.address().port;
}

describe('WebChannel', () => {
  let channel: WebChannel;

  beforeEach(() => {
    _initTestDatabase();
  });

  afterEach(async () => {
    if (channel) await channel.disconnect();
  });

  it('ownsJid returns true for web: prefix', () => {
    channel = new WebChannel(createOpts());
    expect(channel.ownsJid('web:default')).toBe(true);
    expect(channel.ownsJid('web:other')).toBe(true);
    expect(channel.ownsJid('tg:123')).toBe(false);
    expect(channel.ownsJid('whatsapp@g.us')).toBe(false);
  });

  it('connects and disconnects', async () => {
    channel = new WebChannel(createOpts());
    expect(channel.isConnected()).toBe(false);
    await channel.connect();
    expect(channel.isConnected()).toBe(true);
    await channel.disconnect();
    expect(channel.isConnected()).toBe(false);
  });

  it('rejects API requests without token', async () => {
    channel = new WebChannel(createOpts());
    await channel.connect();
    const port = getPort(channel);

    const res = await fetch(`http://127.0.0.1:${port}/api/rooms/default/history`);
    expect(res.status).toBe(401);
  });

  it('accepts API requests with valid token', async () => {
    channel = new WebChannel(createOpts());
    await channel.connect();
    const port = getPort(channel);

    const res = await fetch(`http://127.0.0.1:${port}/api/rooms/default/history?token=test-token-123`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
  });

  it('accepts Bearer token auth', async () => {
    channel = new WebChannel(createOpts());
    await channel.connect();
    const port = getPort(channel);

    const res = await fetch(`http://127.0.0.1:${port}/api/rooms/default/history`, {
      headers: { Authorization: 'Bearer test-token-123' },
    });
    expect(res.status).toBe(200);
  });

  it('delivers inbound message via onMessage callback', async () => {
    const onMessage = vi.fn();
    channel = new WebChannel(createOpts({ onMessage }));
    await channel.connect();
    const port = getPort(channel);

    const res = await fetch(`http://127.0.0.1:${port}/api/rooms/default/send?token=test-token-123`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Hello agent' }),
    });

    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok: boolean; message: { content: string } };
    expect(data.ok).toBe(true);
    expect(data.message.content).toBe('Hello agent');
    expect(onMessage).toHaveBeenCalledOnce();
    expect(onMessage.mock.calls[0][0]).toBe('web:default');
    expect(onMessage.mock.calls[0][1].content).toBe('Hello agent');
  });

  it('stores bot messages on sendMessage and returns them in history', async () => {
    channel = new WebChannel(createOpts());
    await channel.connect();
    const port = getPort(channel);

    // Create chat record (FK constraint requires it)
    storeChatMetadata('web:default', new Date().toISOString(), 'Web Chat', 'web', false);

    await channel.sendMessage('web:default', 'Hello from bot');

    const messages = getRecentMessages('web:default', 10);
    expect(messages.length).toBe(1);
    expect(messages[0].content).toBe('Hello from bot');
    expect(messages[0].is_bot_message).toBeTruthy();

    const res = await fetch(`http://127.0.0.1:${port}/api/rooms/default/history?token=test-token-123`);
    const data = (await res.json()) as Array<{ content: string; is_bot_message: number }>;
    expect(data.length).toBe(1);
    expect(data[0].content).toBe('Hello from bot');
  });

  it('broadcasts sendMessage to SSE clients for that room', async () => {
    channel = new WebChannel(createOpts());
    await channel.connect();
    const port = getPort(channel);

    // Create chat record (FK constraint requires it)
    storeChatMetadata('web:default', new Date().toISOString(), 'Web Chat', 'web', false);

    // Connect SSE client to default room
    const sseResponse = await fetch(`http://127.0.0.1:${port}/api/rooms/default/events?token=test-token-123`);
    const reader = sseResponse.body!.getReader();
    const decoder = new TextDecoder();

    // Read initial :ok
    const { value: initial } = await reader.read();
    expect(decoder.decode(initial)).toContain(':ok');

    // Send a bot message
    await channel.sendMessage('web:default', 'Bot reply');

    // Read the SSE event
    const { value: event } = await reader.read();
    const text = decoder.decode(event);
    expect(text).toContain('event: message');
    expect(text).toContain('Bot reply');

    reader.cancel();
  });

  it('rejects POST /api/rooms/:room/send with missing text', async () => {
    channel = new WebChannel(createOpts());
    await channel.connect();
    const port = getPort(channel);

    const res = await fetch(`http://127.0.0.1:${port}/api/rooms/default/send?token=test-token-123`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('serves room list HTML at root with valid token', async () => {
    channel = new WebChannel(createOpts());
    await channel.connect();
    const port = getPort(channel);

    const res = await fetch(`http://127.0.0.1:${port}/?token=test-token-123`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('NanoPod');
    expect(html).toContain('room-list');
  });

  it('serves chat UI at /r/{room} with valid token', async () => {
    channel = new WebChannel(createOpts());
    await channel.connect();
    const port = getPort(channel);

    const res = await fetch(`http://127.0.0.1:${port}/r/default?token=test-token-123`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('NanoPod');
    expect(html).toContain('/api/rooms/');
  });

  it('returns 404 for unknown room at /r/{room}', async () => {
    channel = new WebChannel(createOpts());
    await channel.connect();
    const port = getPort(channel);

    const res = await fetch(`http://127.0.0.1:${port}/r/nonexistent?token=test-token-123`);
    expect(res.status).toBe(404);
  });

  it('lists web: rooms via GET /api/rooms', async () => {
    const groups: Record<string, RegisteredGroup> = {
      'web:default': {
        name: 'Web Chat',
        folder: 'web-default',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
        requiresTrigger: false,
      },
      'web:work': {
        name: 'Work',
        folder: 'web-work',
        trigger: '@Andy',
        added_at: '2024-01-02T00:00:00.000Z',
        requiresTrigger: false,
      },
      'tg:123': {
        name: 'Telegram Group',
        folder: 'tg-group',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    };
    channel = new WebChannel(createOpts({ registeredGroups: () => groups }));
    await channel.connect();
    const port = getPort(channel);

    const res = await fetch(`http://127.0.0.1:${port}/api/rooms?token=test-token-123`);
    expect(res.status).toBe(200);
    const rooms = (await res.json()) as Array<{ slug: string; name: string; jid: string }>;
    expect(rooms.length).toBe(2);
    expect(rooms.map((r) => r.slug).sort()).toEqual(['default', 'work']);
    // Should not include Telegram group
    expect(rooms.every((r) => r.jid.startsWith('web:'))).toBe(true);
  });

  it('creates a new room via POST /api/rooms', async () => {
    const groups: Record<string, RegisteredGroup> = {};
    const onRegisterGroup = vi.fn((jid: string, group: RegisteredGroup) => {
      groups[jid] = group;
    });
    channel = new WebChannel(createOpts({
      registeredGroups: () => groups,
      onRegisterGroup,
    }));
    await channel.connect();
    const port = getPort(channel);

    const res = await fetch(`http://127.0.0.1:${port}/api/rooms?token=test-token-123`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'My Project' }),
    });

    expect(res.status).toBe(201);
    const data = (await res.json()) as { slug: string; name: string; jid: string };
    expect(data.slug).toBe('my-project');
    expect(data.jid).toBe('web:my-project');
    expect(data.name).toBe('My Project');
    expect(onRegisterGroup).toHaveBeenCalledOnce();
    expect(onRegisterGroup.mock.calls[0][0]).toBe('web:my-project');
    expect(onRegisterGroup.mock.calls[0][1].folder).toBe('web-my-project');
    expect(onRegisterGroup.mock.calls[0][1].requiresTrigger).toBe(false);
  });

  it('rejects duplicate room creation', async () => {
    const groups: Record<string, RegisteredGroup> = {
      'web:work': {
        name: 'Work',
        folder: 'web-work',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
        requiresTrigger: false,
      },
    };
    channel = new WebChannel(createOpts({
      registeredGroups: () => groups,
      onRegisterGroup: vi.fn(),
    }));
    await channel.connect();
    const port = getPort(channel);

    const res = await fetch(`http://127.0.0.1:${port}/api/rooms?token=test-token-123`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Work' }),
    });

    expect(res.status).toBe(409);
  });

  it('isolates SSE events between rooms', async () => {
    const groups: Record<string, RegisteredGroup> = {
      'web:room-a': {
        name: 'Room A',
        folder: 'web-room-a',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
        requiresTrigger: false,
      },
      'web:room-b': {
        name: 'Room B',
        folder: 'web-room-b',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
        requiresTrigger: false,
      },
    };
    channel = new WebChannel(createOpts({ registeredGroups: () => groups }));
    await channel.connect();
    const port = getPort(channel);

    // Create chat records for both rooms
    storeChatMetadata('web:room-a', new Date().toISOString(), 'Room A', 'web', false);
    storeChatMetadata('web:room-b', new Date().toISOString(), 'Room B', 'web', false);

    // Connect SSE to room-a
    const sseA = await fetch(`http://127.0.0.1:${port}/api/rooms/room-a/events?token=test-token-123`);
    const readerA = sseA.body!.getReader();
    const decoder = new TextDecoder();

    // Read :ok from room-a
    const { value: initA } = await readerA.read();
    expect(decoder.decode(initA)).toContain(':ok');

    // Send a message to room-b — should NOT appear in room-a's SSE
    await channel.sendMessage('web:room-b', 'Message for room B');

    // Send a message to room-a — should appear
    await channel.sendMessage('web:room-a', 'Message for room A');

    // Read room-a's event — should only contain room-a's message
    const { value: eventA } = await readerA.read();
    const textA = decoder.decode(eventA);
    expect(textA).toContain('Message for room A');
    expect(textA).not.toContain('Message for room B');

    readerA.cancel();
  });

  it('sendMessage without metadata uses default sender_name', async () => {
    channel = new WebChannel(createOpts());
    await channel.connect();

    storeChatMetadata('web:default', new Date().toISOString(), 'Web Chat', 'web', false);

    await channel.sendMessage('web:default', 'Hello from default');

    const messages = getRecentMessages('web:default', 10);
    expect(messages.length).toBe(1);
    expect(messages[0].sender).toBe('bot');
    // sender_name should be ASSISTANT_NAME (from config, resolved at runtime)
    expect(messages[0].sender_name).toBeTruthy();
    expect(messages[0].is_bot_message).toBeTruthy();
  });

  it('sendMessage with metadata.senderName uses custom sender', async () => {
    channel = new WebChannel(createOpts());
    await channel.connect();

    storeChatMetadata('web:default', new Date().toISOString(), 'Web Chat', 'web', false);

    await channel.sendMessage('web:default', 'Research complete', { senderName: 'Researcher' });

    const messages = getRecentMessages('web:default', 10);
    expect(messages.length).toBe(1);
    expect(messages[0].sender).toBe('Researcher');
    expect(messages[0].sender_name).toBe('Researcher');
    expect(messages[0].content).toBe('Research complete');
    expect(messages[0].is_bot_message).toBeTruthy();
  });

  it('returns 404 when sending to non-existent room', async () => {
    channel = new WebChannel(createOpts());
    await channel.connect();
    const port = getPort(channel);

    const res = await fetch(`http://127.0.0.1:${port}/api/rooms/nonexistent/send?token=test-token-123`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Hello' }),
    });
    expect(res.status).toBe(404);
  });
});
