import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import chalk from 'chalk';

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf-8'));
import { MessageParser, serializeMessage, isRequest, isResponse } from './message.js';
import type { JsonRpcMessage, JsonRpcRequest, JsonRpcResponse, VedisConfig, ToolCallParams, AuditEntry } from '../types.js';
import { Scanner } from '../middleware/scanner.js';
import { PolicyEngine } from '../middleware/policy.js';
import { OutputFilter } from '../middleware/filter.js';
import { AuditLogger } from '../middleware/audit.js';
import { RateLimiter } from '../middleware/rate-limiter.js';
import { getDashboardHTML } from '../dashboard.js';
import { getLandingHTML } from '../landing.js';

/**
 * Upstream abstraction — either a spawned child process or an HTTP URL endpoint.
 * Allows sessions to communicate with both local (stdio) and remote (HTTP) MCP servers.
 */
interface UpstreamHandle {
  send(msg: JsonRpcMessage): void;
  close(): void;
}

interface Session {
  id: string;
  upstream: UpstreamHandle;
  res: ServerResponse;
  pendingRequests: Map<string | number, { method: string; tool?: string; startTime: number }>;
}

export class SSEServer {
  private scanner: Scanner;
  private policy: PolicyEngine;
  private filter: OutputFilter;
  private audit: AuditLogger;
  private rateLimiter: RateLimiter;
  private config: VedisConfig;
  private sessions = new Map<string, Session>();
  private recentLogs: AuditEntry[] = [];
  private statsCounter = { scanned: 0, blocked: 0 };
  private startTime = Date.now();

  constructor(config: VedisConfig) {
    this.config = config;
    this.scanner = new Scanner(config.scanner);
    this.policy = new PolicyEngine(config.policy);
    this.filter = new OutputFilter(config.filter);
    this.audit = new AuditLogger(config.audit);
    this.rateLimiter = new RateLimiter(config.rateLimit);
  }

  start(): void {
    const port = this.config.server?.port ?? parseInt(process.env['PORT'] ?? '8080', 10);
    const host = this.config.server?.host ?? '0.0.0.0';

    const server = createServer((req, res) => this.handleRequest(req, res));

    // Graceful shutdown
    const shutdown = () => {
      console.error(chalk.yellow('[vedis] Shutting down...'));
      for (const [id, session] of this.sessions) {
        session.upstream.close();
        if (!session.res.writableEnded) session.res.end();
        this.sessions.delete(id);
      }
      this.audit.close();
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(1), 5000); // force exit after 5s
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

    server.listen(port, host, () => {
      console.error(chalk.blue(`[vedis] SSE server listening on ${host}:${port}`));
      console.error(chalk.blue(`[vedis] Scanner: ${this.config.scanner?.enabled ? 'ON' : 'OFF'} | Policy: ${this.config.policy?.tools ? 'ON' : 'OFF'} | Filter: ${this.config.filter?.enabled ? 'ON' : 'OFF'}`));
    });
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

    // Health check
    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        version: pkg.version,
        sessions: this.sessions.size,
        scanner: this.config.scanner?.enabled ?? true,
      }));
      return;
    }

    // SSE endpoint — client connects here for server-sent events
    if (url.pathname === '/sse' && req.method === 'GET') {
      this.handleSSEConnect(req, res);
      return;
    }

    // Message endpoint — client POSTs JSON-RPC messages here
    if (url.pathname === '/message' && req.method === 'POST') {
      this.handleMessage(req, res);
      return;
    }

    // Stats endpoint
    if (url.pathname === '/stats') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        activeSessions: this.sessions.size,
        uptime: process.uptime(),
        scanned: this.statsCounter.scanned,
        blocked: this.statsCounter.blocked,
      }));
      return;
    }

    // Dashboard API: scan text
    if (url.pathname === '/api/scan' && req.method === 'POST') {
      this.handleAPIScan(req, res);
      return;
    }

    // Dashboard API: recent audit logs
    if (url.pathname === '/api/logs') {
      const limit = parseInt(url.searchParams.get('limit') ?? '20', 10);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(this.recentLogs.slice(-limit).reverse()));
      return;
    }

    // Dashboard API: config summary
    if (url.pathname === '/api/config') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        scanner: this.config.scanner?.enabled ?? true,
        sensitivity: this.config.scanner?.sensitivity ?? 'medium',
        action: this.config.scanner?.action ?? 'block',
        filter: this.config.filter?.enabled ?? true,
        pii: this.config.filter?.pii ?? true,
        secrets: this.config.filter?.secrets ?? true,
        rateLimit: this.config.rateLimit?.requestsPerMinute ?? 120,
      }));
      return;
    }

    // Landing page
    if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(getLandingHTML());
      return;
    }

    // Dashboard UI
    if (url.pathname === '/dashboard') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(getDashboardHTML());
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }

  private readBody(req: IncomingMessage, maxBytes: number = 1_048_576): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = '';
      let size = 0;
      req.on('data', (chunk: Buffer | string) => {
        size += typeof chunk === 'string' ? chunk.length : chunk.byteLength;
        if (size > maxBytes) {
          req.destroy();
          reject(new Error('Body too large'));
          return;
        }
        body += chunk;
      });
      req.on('end', () => resolve(body));
      req.on('error', reject);
    });
  }

  private async handleAPIScan(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const body = await this.readBody(req, 102_400); // 100KB max for scan
      const { text } = JSON.parse(body) as { text: string };
      if (!text) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing text field' }));
        return;
      }
      const result = this.scanner.scan(text);
      this.statsCounter.scanned++;
      if (result.blocked) this.statsCounter.blocked++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      const msg = err instanceof Error && err.message === 'Body too large' ? 'Request body too large (max 100KB)' : 'Invalid JSON body';
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: msg }));
    }
  }

  private trackAudit(entry: AuditEntry): void {
    this.audit.log(entry);
    this.recentLogs.push(entry);
    if (this.recentLogs.length > 200) this.recentLogs.splice(0, this.recentLogs.length - 200);
    this.statsCounter.scanned++;
    if (entry.blocked) this.statsCounter.blocked++;
  }

  /**
   * Spawn a child process as the upstream MCP server for a session.
   * Returns an UpstreamHandle that writes JSON-RPC messages to stdin
   * and calls onMessage for each parsed message from stdout.
   */
  private spawnProcessUpstream(
    sessionId: string,
    res: ServerResponse,
    onMessage: (msg: JsonRpcMessage) => void,
    onExit: () => void,
  ): UpstreamHandle | null {
    const { command, args = [], env } = this.config.upstream;

    if (!command) return null;

    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });

    if (!child.stdin || !child.stdout) {
      child.kill();
      return null;
    }

    const parser = new MessageParser(onMessage);

    child.stdout.on('data', (chunk: Buffer) => {
      parser.feed(chunk.toString());
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      console.error(chalk.gray(`[vedis:${sessionId.slice(0, 8)}] ${chunk.toString().trim()}`));
    });

    child.on('exit', onExit);

    return {
      send(msg: JsonRpcMessage) {
        child.stdin!.write(serializeMessage(msg));
      },
      close() {
        child.kill();
      },
    };
  }

  /**
   * Connect to a remote upstream MCP server via HTTP(S).
   * Each message is POSTed as JSON-RPC to the upstream URL.
   * The response body is parsed as a JSON-RPC message and forwarded back.
   */
  private createUrlUpstream(
    upstreamUrl: string,
    onMessage: (msg: JsonRpcMessage) => void,
  ): UpstreamHandle {
    const parsedUrl = new URL(upstreamUrl);
    const doRequest = parsedUrl.protocol === 'https:' ? httpsRequest : httpRequest;

    return {
      send(msg: JsonRpcMessage) {
        const body = JSON.stringify(msg);
        const opts = {
          method: 'POST',
          hostname: parsedUrl.hostname,
          port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
          path: parsedUrl.pathname + parsedUrl.search,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
        };

        const req = doRequest(opts, (res) => {
          let data = '';
          res.on('data', (chunk: Buffer | string) => { data += chunk; });
          res.on('end', () => {
            if (!data.trim()) return; // no response body (e.g. notifications)
            try {
              const parsed = JSON.parse(data) as JsonRpcMessage;
              onMessage(parsed);
            } catch {
              // Non-JSON response — skip
            }
          });
        });

        req.on('error', (err) => {
          console.error(chalk.red(`[vedis] Upstream URL error: ${err.message}`));
        });

        req.write(body);
        req.end();
      },
      close() {
        // No persistent connection to tear down for HTTP mode
      },
    };
  }

  private handleSSEConnect(_req: IncomingMessage, res: ServerResponse): void {
    const sessionId = randomUUID();
    const { command, url } = this.config.upstream;

    if (!command && !url) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No upstream configured — set upstream.command or upstream.url' }));
      return;
    }

    // SSE headers — sent before spawning so the client gets a fast connection
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    // Send session ID as first event
    res.write(`event: endpoint\ndata: /message?sessionId=${sessionId}\n\n`);

    // Build the session shell first so callbacks can reference it
    const session: Session = {
      id: sessionId,
      upstream: null as unknown as UpstreamHandle, // set below
      res,
      pendingRequests: new Map(),
    };

    const onMessage = (msg: JsonRpcMessage) => this.handleUpstreamMessage(session, msg);
    const onExit = () => {
      this.sessions.delete(sessionId);
      if (!res.writableEnded) {
        res.write('event: close\ndata: upstream exited\n\n');
        res.end();
      }
    };

    let upstream: UpstreamHandle | null;

    if (url) {
      // URL mode — proxy to a remote MCP server over HTTP(S)
      upstream = this.createUrlUpstream(url, onMessage);
      console.error(chalk.green(`[vedis] Session ${sessionId.slice(0, 8)} connected (url: ${url})`));
    } else {
      // Process mode — spawn a child process per session
      upstream = this.spawnProcessUpstream(sessionId, res, onMessage, onExit);
      if (!upstream) {
        res.write('event: close\ndata: failed to spawn upstream\n\n');
        res.end();
        return;
      }
      console.error(chalk.green(`[vedis] Session ${sessionId.slice(0, 8)} connected (process: ${command})`));
    }

    session.upstream = upstream;
    this.sessions.set(sessionId, session);

    // Cleanup on client disconnect
    res.on('close', () => {
      this.sessions.delete(sessionId);
      upstream!.close();
    });
  }

  private handleMessage(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const sessionId = url.searchParams.get('sessionId');

    if (!sessionId || !this.sessions.has(sessionId)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Session not found' }));
      return;
    }

    const session = this.sessions.get(sessionId)!;

    this.readBody(req).then((body) => {
      const msg = JSON.parse(body) as JsonRpcMessage;
      this.handleClientMessage(session, msg, res);
    }).catch((err) => {
      const msg = err instanceof Error && err.message === 'Body too large' ? 'Request body too large' : 'Invalid JSON';
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: msg }));
    });
  }

  private handleClientMessage(session: Session, msg: JsonRpcMessage, res: ServerResponse): void {
    const startTime = Date.now();

    if (isRequest(msg)) {
      const req = msg as JsonRpcRequest;

      if (!this.rateLimiter.allow()) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Rate limit exceeded' }));
        return;
      }

      if (req.method === 'tools/call') {
        const params = req.params as unknown as ToolCallParams;
        const toolName = params?.name ?? 'unknown';

        if (req.id !== undefined) {
          session.pendingRequests.set(req.id, { method: req.method, tool: toolName, startTime });
        }

        // Policy check
        const policyResult = this.policy.check(toolName, params?.arguments);
        if (!policyResult.allowed) {
          console.error(chalk.red(`[vedis] BLOCKED by policy: ${toolName}`));
          this.sendSSEError(session, req, -32001, `Vedis policy: ${policyResult.reason}`);
          res.writeHead(200);
          res.end();
          return;
        }

        // Scan
        const scanResult = this.scanner.scan(JSON.stringify(params));
        if (scanResult.blocked) {
          const threatNames = scanResult.threats.map(t => t.type).join(', ');
          console.error(chalk.red(`[vedis] BLOCKED by scanner: ${toolName} — ${threatNames}`));
          this.trackAudit({
            timestamp: new Date().toISOString(),
            direction: 'request',
            method: req.method,
            tool: toolName,
            blocked: true,
            threats: scanResult.threats,
            filtered: [],
            latencyMs: Date.now() - startTime,
          });
          this.sendSSEError(session, req, -32002, `Vedis scanner: injection detected (${threatNames})`);
          res.writeHead(200);
          res.end();
          return;
        }
      } else if (req.id !== undefined) {
        session.pendingRequests.set(req.id, { method: req.method, startTime });
      }
    }

    // Forward to upstream
    session.upstream.send(msg);
    res.writeHead(202);
    res.end();
  }

  private handleUpstreamMessage(session: Session, msg: JsonRpcMessage): void {
    if (isResponse(msg)) {
      const resp = msg as JsonRpcResponse;
      const pending = resp.id !== undefined ? session.pendingRequests.get(resp.id) : undefined;

      if (pending) {
        session.pendingRequests.delete(resp.id);

        if (pending.method === 'tools/call' && resp.result) {
          const { filtered, result } = this.filter.filterResult(resp.result);
          if (filtered.length > 0) {
            console.error(chalk.magenta(`[vedis] Filtered: ${filtered.join(', ')}`));
            resp.result = result;
          }

          this.trackAudit({
            timestamp: new Date().toISOString(),
            direction: 'response',
            method: pending.method,
            tool: pending.tool,
            blocked: false,
            threats: [],
            filtered,
            latencyMs: Date.now() - pending.startTime,
          });
        }
      }
    }

    // Send as SSE event
    if (!session.res.writableEnded) {
      session.res.write(`event: message\ndata: ${JSON.stringify(msg)}\n\n`);
    }
  }

  private sendSSEError(session: Session, req: JsonRpcRequest, code: number, message: string): void {
    const errorResp: JsonRpcResponse = {
      jsonrpc: '2.0',
      id: req.id!,
      error: { code, message },
    };
    if (!session.res.writableEnded) {
      session.res.write(`event: message\ndata: ${JSON.stringify(errorResp)}\n\n`);
    }
  }
}
