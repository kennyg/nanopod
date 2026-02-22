import http from 'http';
import crypto from 'crypto';

import { ASSISTANT_NAME } from '../config.js';
import { getRecentMessages, storeMessageDirect } from '../db.js';
import { logger } from '../logger.js';
import { Channel, MessageMetadata, NewMessage, OnChatMetadata, OnInboundMessage, RegisteredGroup } from '../types.js';
import { getWebUiHtml, getRoomListHtml } from './web-ui.js';

export interface WebChannelOpts {
  port: number;
  token: string;
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  onRegisterGroup?: (jid: string, group: RegisteredGroup) => void;
}

interface SseClient {
  res: http.ServerResponse;
  keepAliveTimer: ReturnType<typeof setInterval>;
}

export class WebChannel implements Channel {
  name = 'web';
  private server: http.Server | null = null;
  private clientsByRoom: Map<string, SseClient[]> = new Map();
  private port: number;
  private token: string;
  private connected = false;
  private onMessage: OnInboundMessage;
  private onChatMetadata: OnChatMetadata;
  private registeredGroups: () => Record<string, RegisteredGroup>;
  private onRegisterGroup?: (jid: string, group: RegisteredGroup) => void;

  constructor(opts: WebChannelOpts) {
    this.port = opts.port;
    this.token = opts.token;
    this.onMessage = opts.onMessage;
    this.onChatMetadata = opts.onChatMetadata;
    this.registeredGroups = opts.registeredGroups;
    this.onRegisterGroup = opts.onRegisterGroup;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handleRequest(req, res));
      this.server.listen(this.port, () => {
        this.connected = true;
        logger.info({ port: this.port }, 'Web gateway listening');
        resolve();
      });
      this.server.on('error', (err) => {
        if (!this.connected) reject(err);
        else logger.error({ err }, 'Web gateway server error');
      });
    });
  }

  async sendMessage(jid: string, text: string, metadata?: MessageMetadata): Promise<void> {
    if (!jid.startsWith('web:')) return;

    const msg = {
      id: `bot-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
      chat_jid: jid,
      sender: metadata?.senderName ?? 'bot',
      sender_name: metadata?.senderName ?? ASSISTANT_NAME,
      content: text,
      timestamp: new Date().toISOString(),
      is_from_me: false,
      is_bot_message: true,
    };

    // Store bot response in SQLite (web channel needs this for history)
    storeMessageDirect(msg);

    // Broadcast to SSE clients subscribed to this room
    const data = JSON.stringify(msg);
    const clients = this.clientsByRoom.get(jid) || [];
    for (const client of clients) {
      client.res.write(`event: message\ndata: ${data}\n\n`);
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('web:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    for (const [, clients] of this.clientsByRoom) {
      for (const client of clients) {
        clearInterval(client.keepAliveTimer);
        client.res.end();
      }
    }
    this.clientsByRoom.clear();
    return new Promise((resolve) => {
      if (this.server) this.server.close(() => resolve());
      else resolve();
    });
  }

  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // Could send a typing SSE event in the future
  }

  private authenticate(req: http.IncomingMessage): boolean {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const queryToken = url.searchParams.get('token');
    if (queryToken === this.token) return true;

    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ') && authHeader.slice(7) === this.token) return true;

    return false;
  }

  /** Extract room slug from a URL path like /api/rooms/{room}/... or /r/{room} */
  private extractRoomSlug(pathname: string): string | null {
    // Match /api/rooms/{room}/... or /r/{room}
    const apiMatch = pathname.match(/^\/api\/rooms\/([^/]+)/);
    if (apiMatch) return decodeURIComponent(apiMatch[1]);
    const uiMatch = pathname.match(/^\/r\/([^/]+)/);
    if (uiMatch) return decodeURIComponent(uiMatch[1]);
    return null;
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    // CORS headers for local development
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Serve room list at root
    if (pathname === '/' && req.method === 'GET') {
      if (!this.authenticate(req)) {
        res.writeHead(401, { 'Content-Type': 'text/plain' });
        res.end('Unauthorized — append ?token=<your-token> to the URL');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(getRoomListHtml(this.token));
      return;
    }

    // Serve chat UI at /r/{room}
    const uiRoomMatch = pathname.match(/^\/r\/([^/]+)$/);
    if (uiRoomMatch && req.method === 'GET') {
      if (!this.authenticate(req)) {
        res.writeHead(401, { 'Content-Type': 'text/plain' });
        res.end('Unauthorized — append ?token=<your-token> to the URL');
        return;
      }
      const room = decodeURIComponent(uiRoomMatch[1]);
      const jid = `web:${room}`;
      const groups = this.registeredGroups();
      if (!groups[jid]) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Room not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(getWebUiHtml(this.token, room));
      return;
    }

    // All API routes require auth
    if (pathname.startsWith('/api/') && !this.authenticate(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    // GET /api/rooms — list all web: rooms
    if (pathname === '/api/rooms' && req.method === 'GET') {
      this.handleListRooms(res);
      return;
    }

    // POST /api/rooms — create new room
    if (pathname === '/api/rooms' && req.method === 'POST') {
      this.handleCreateRoom(req, res);
      return;
    }

    // Per-room routes: /api/rooms/{room}/...
    const roomSlug = this.extractRoomSlug(pathname);
    if (roomSlug && pathname.startsWith('/api/rooms/')) {
      const suffix = pathname.replace(`/api/rooms/${encodeURIComponent(roomSlug)}`, '');

      if (suffix === '/events' && req.method === 'GET') {
        this.handleSse(req, res, roomSlug);
        return;
      }

      if (suffix === '/send' && req.method === 'POST') {
        this.handleSend(req, res, roomSlug);
        return;
      }

      if (suffix === '/history' && req.method === 'GET') {
        this.handleHistory(res, roomSlug);
        return;
      }
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }

  private handleListRooms(res: http.ServerResponse): void {
    const groups = this.registeredGroups();
    const rooms = Object.entries(groups)
      .filter(([jid]) => jid.startsWith('web:'))
      .map(([jid, group]) => ({
        slug: jid.slice(4), // strip 'web:' prefix
        name: group.name,
        jid,
        added_at: group.added_at,
      }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(rooms));
  }

  private handleCreateRoom(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (!this.onRegisterGroup) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Room creation not available' }));
      return;
    }

    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
      if (body.length > 10_000) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Payload too large' }));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        const { name } = JSON.parse(body);
        if (!name || typeof name !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing "name" field' }));
          return;
        }

        // Slugify the name
        const slug = name
          .toLowerCase()
          .trim()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '');

        if (!slug) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid room name' }));
          return;
        }

        const jid = `web:${slug}`;
        const groups = this.registeredGroups();

        if (groups[jid]) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Room already exists', slug }));
          return;
        }

        const group: RegisteredGroup = {
          name,
          folder: `web-${slug}`,
          trigger: `@${ASSISTANT_NAME}`,
          added_at: new Date().toISOString(),
          requiresTrigger: false,
        };

        this.onRegisterGroup!(jid, group);

        // Store chat metadata so history works
        this.onChatMetadata(jid, group.added_at, name, 'web', false);

        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ slug, name, jid }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
  }

  private handleSse(_req: http.IncomingMessage, res: http.ServerResponse, room: string): void {
    const jid = `web:${room}`;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', // Disable nginx buffering
    });
    res.write(':ok\n\n');

    const keepAliveTimer = setInterval(() => {
      res.write(':ping\n\n');
    }, 30000);

    const client: SseClient = { res, keepAliveTimer };

    if (!this.clientsByRoom.has(jid)) {
      this.clientsByRoom.set(jid, []);
    }
    this.clientsByRoom.get(jid)!.push(client);

    res.on('close', () => {
      clearInterval(keepAliveTimer);
      const clients = this.clientsByRoom.get(jid);
      if (clients) {
        const filtered = clients.filter((c) => c !== client);
        if (filtered.length === 0) this.clientsByRoom.delete(jid);
        else this.clientsByRoom.set(jid, filtered);
      }
    });
  }

  private handleSend(req: http.IncomingMessage, res: http.ServerResponse, room: string): void {
    const jid = `web:${room}`;

    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
      if (body.length > 100_000) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Payload too large' }));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        const { text } = JSON.parse(body);
        if (!text || typeof text !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing "text" field' }));
          return;
        }

        const groups = this.registeredGroups();
        if (!groups[jid]) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Room not found' }));
          return;
        }

        const msg: NewMessage = {
          id: `web-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
          chat_jid: jid,
          sender: 'user',
          sender_name: 'You',
          content: text.trim(),
          timestamp: new Date().toISOString(),
          is_from_me: true,
          is_bot_message: false,
        };

        // Store and deliver to orchestrator
        this.onChatMetadata(jid, msg.timestamp, groups[jid].name, 'web', false);
        this.onMessage(jid, msg);

        // Broadcast to SSE clients for this room (so other tabs see it)
        const data = JSON.stringify(msg);
        const clients = this.clientsByRoom.get(jid) || [];
        for (const client of clients) {
          client.res.write(`event: message\ndata: ${data}\n\n`);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, message: msg }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
  }

  private handleHistory(res: http.ServerResponse, room: string): void {
    const jid = `web:${room}`;
    const messages = getRecentMessages(jid, 50);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(messages));
  }
}
