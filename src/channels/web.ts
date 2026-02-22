import http from 'http';
import crypto from 'crypto';

import { ASSISTANT_NAME } from '../config.js';
import { getRecentMessages, storeMessageDirect } from '../db.js';
import { logger } from '../logger.js';
import { Channel, NewMessage, OnChatMetadata, OnInboundMessage, RegisteredGroup } from '../types.js';
import { getWebUiHtml } from './web-ui.js';

const WEB_JID = 'web:default';

export interface WebChannelOpts {
  port: number;
  token: string;
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

interface SseClient {
  res: http.ServerResponse;
  keepAliveTimer: ReturnType<typeof setInterval>;
}

export class WebChannel implements Channel {
  name = 'web';
  private server: http.Server | null = null;
  private clients: SseClient[] = [];
  private port: number;
  private token: string;
  private connected = false;
  private onMessage: OnInboundMessage;
  private onChatMetadata: OnChatMetadata;

  constructor(opts: WebChannelOpts) {
    this.port = opts.port;
    this.token = opts.token;
    this.onMessage = opts.onMessage;
    this.onChatMetadata = opts.onChatMetadata;
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

  async sendMessage(jid: string, text: string): Promise<void> {
    if (jid !== WEB_JID) return;

    const msg = {
      id: `bot-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
      chat_jid: WEB_JID,
      sender: 'bot',
      sender_name: ASSISTANT_NAME,
      content: text,
      timestamp: new Date().toISOString(),
      is_from_me: false,
      is_bot_message: true,
    };

    // Store bot response in SQLite (web channel needs this for history)
    storeMessageDirect(msg);

    // Broadcast to all SSE clients
    const data = JSON.stringify(msg);
    for (const client of this.clients) {
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
    for (const client of this.clients) {
      clearInterval(client.keepAliveTimer);
      client.res.end();
    }
    this.clients = [];
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

    // Serve HTML at root (auth via query param embedded in page)
    if (pathname === '/' && req.method === 'GET') {
      if (!this.authenticate(req)) {
        res.writeHead(401, { 'Content-Type': 'text/plain' });
        res.end('Unauthorized — append ?token=<your-token> to the URL');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(getWebUiHtml(this.token));
      return;
    }

    // All API routes require auth
    if (pathname.startsWith('/api/') && !this.authenticate(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    if (pathname === '/api/events' && req.method === 'GET') {
      this.handleSse(req, res);
      return;
    }

    if (pathname === '/api/send' && req.method === 'POST') {
      this.handleSend(req, res);
      return;
    }

    if (pathname === '/api/history' && req.method === 'GET') {
      this.handleHistory(res);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }

  private handleSse(_req: http.IncomingMessage, res: http.ServerResponse): void {
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
    this.clients.push(client);

    res.on('close', () => {
      clearInterval(keepAliveTimer);
      this.clients = this.clients.filter((c) => c !== client);
    });
  }

  private handleSend(req: http.IncomingMessage, res: http.ServerResponse): void {
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

        const msg: NewMessage = {
          id: `web-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
          chat_jid: WEB_JID,
          sender: 'user',
          sender_name: 'You',
          content: text.trim(),
          timestamp: new Date().toISOString(),
          is_from_me: true,
          is_bot_message: false,
        };

        // Store and deliver to orchestrator
        this.onChatMetadata(WEB_JID, msg.timestamp, 'Web Chat', 'web', false);
        this.onMessage(WEB_JID, msg);

        // Broadcast to SSE clients (so other tabs see it)
        const data = JSON.stringify(msg);
        for (const client of this.clients) {
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

  private handleHistory(res: http.ServerResponse): void {
    const messages = getRecentMessages(WEB_JID, 50);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(messages));
  }
}
