import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _initTestDatabase, getRecentMessages, storeChatMetadata } from '../db.js';
import { WebChannel, WebChannelOpts } from './web.js';

// Shared test setup
function createOpts(overrides?: Partial<WebChannelOpts>): WebChannelOpts {
  return {
    port: 0, // OS-assigned port
    token: 'test-token-123',
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: () => ({}),
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

    const res = await fetch(`http://127.0.0.1:${port}/api/history`);
    expect(res.status).toBe(401);
  });

  it('accepts API requests with valid token', async () => {
    channel = new WebChannel(createOpts());
    await channel.connect();
    const port = getPort(channel);

    const res = await fetch(`http://127.0.0.1:${port}/api/history?token=test-token-123`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
  });

  it('accepts Bearer token auth', async () => {
    channel = new WebChannel(createOpts());
    await channel.connect();
    const port = getPort(channel);

    const res = await fetch(`http://127.0.0.1:${port}/api/history`, {
      headers: { Authorization: 'Bearer test-token-123' },
    });
    expect(res.status).toBe(200);
  });

  it('delivers inbound message via onMessage callback', async () => {
    const onMessage = vi.fn();
    channel = new WebChannel(createOpts({ onMessage }));
    await channel.connect();
    const port = getPort(channel);

    const res = await fetch(`http://127.0.0.1:${port}/api/send?token=test-token-123`, {
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

    const res = await fetch(`http://127.0.0.1:${port}/api/history?token=test-token-123`);
    const data = (await res.json()) as Array<{ content: string; is_bot_message: number }>;
    expect(data.length).toBe(1);
    expect(data[0].content).toBe('Hello from bot');
  });

  it('broadcasts sendMessage to SSE clients', async () => {
    channel = new WebChannel(createOpts());
    await channel.connect();
    const port = getPort(channel);

    // Create chat record (FK constraint requires it)
    storeChatMetadata('web:default', new Date().toISOString(), 'Web Chat', 'web', false);

    // Connect SSE client
    const sseResponse = await fetch(`http://127.0.0.1:${port}/api/events?token=test-token-123`);
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

  it('rejects POST /api/send with missing text', async () => {
    channel = new WebChannel(createOpts());
    await channel.connect();
    const port = getPort(channel);

    const res = await fetch(`http://127.0.0.1:${port}/api/send?token=test-token-123`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('serves HTML at root with valid token', async () => {
    channel = new WebChannel(createOpts());
    await channel.connect();
    const port = getPort(channel);

    const res = await fetch(`http://127.0.0.1:${port}/?token=test-token-123`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('NanoPod');
  });
});
