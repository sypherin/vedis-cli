import { spawn, type ChildProcess } from 'node:child_process';
import { MessageParser, serializeMessage, isRequest, isResponse } from './message.js';
import type { JsonRpcMessage, JsonRpcRequest, JsonRpcResponse, VedisConfig, ToolCallParams } from '../types.js';
import { Scanner } from '../middleware/scanner.js';
import { PolicyEngine } from '../middleware/policy.js';
import { OutputFilter } from '../middleware/filter.js';
import { AuditLogger } from '../middleware/audit.js';
import { RateLimiter } from '../middleware/rate-limiter.js';
import { BrainClient } from '../middleware/brain.js';
import { Forwarder } from './forwarder.js';
import chalk from 'chalk';
import { randomUUID } from 'node:crypto';
import { buildCallEvent, type EventSeed } from './ingest-record.js';

/** Text of an MCP tool result, for the response_digest / response_bytes columns. */
function responseTextOf(result: unknown): string | null {
  if (result === null || result === undefined) return null;
  const content = (result as { content?: unknown }).content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => typeof (c as { text?: unknown })?.text === 'string')
      .map((c) => String((c as { text?: unknown }).text))
      .join('\n');
  }
  try { return JSON.stringify(result); } catch { return null; }
}

export class StdioProxy {
  private upstream: ChildProcess | null = null;
  private scanner: Scanner;
  private policy: PolicyEngine;
  private filter: OutputFilter;
  private audit: AuditLogger;
  private rateLimiter: RateLimiter;
  private brain: BrainClient;
  private forwarder: Forwarder | null;
  private readonly sessionId: string;
  private eventSeq = 0;
  /** Request-side decision, held until the response arrives so one call == one record. */
  private pendingIngestSeed = new Map<string | number, EventSeed>();
  private config: VedisConfig;
  private pendingRequests = new Map<string | number, { method: string; tool?: string; startTime: number; args?: Record<string, unknown> }>();

  constructor(config: VedisConfig) {
    this.config = config;
    this.scanner = new Scanner(config.scanner);
    this.policy = new PolicyEngine(config.policy);
    this.filter = new OutputFilter(config.filter);
    this.audit = new AuditLogger(config.audit);
    this.rateLimiter = new RateLimiter(config.rateLimit);
    this.brain = new BrainClient(config.brain);
    this.sessionId = `sess_${randomUUID()}`;

    // Telemetry only. Absent endpoint => null, and the proxy behaves exactly as before.
    const ingest = config.ingest;
    this.forwarder = config.ingest?.enabled && config.ingest?.endpoint
      ? new Forwarder({
          endpoint: config.ingest.endpoint!,
          keyId: ingest?.keyId,
          apiKey: ingest?.apiKey,
          clientVersion: ingest?.clientVersion,
          proxyId: ingest?.proxyId,
          queueCap: ingest?.queueCap,
          spoolPath: ingest?.spoolPath,
        })
      : null;
  }

  async start(): Promise<void> {
    const { command, args = [], env } = this.config.upstream;

    if (!command) {
      console.error(chalk.red('No upstream command configured. Set upstream.command in vedis.config.yaml'));
      process.exit(1);
    }

    console.error(chalk.blue(`[vedis] Starting upstream: ${command} ${args.join(' ')}`));
    console.error(chalk.blue(`[vedis] Scanner: ${this.config.scanner?.enabled ? 'ON' : 'OFF'} | Policy: ${this.config.policy?.tools ? 'ON' : 'OFF'} | Filter: ${this.config.filter?.enabled ? 'ON' : 'OFF'}`));

    // Spawn the upstream MCP server
    this.upstream = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });

    if (!this.upstream.stdin || !this.upstream.stdout) {
      console.error(chalk.red('[vedis] Failed to connect to upstream stdin/stdout'));
      process.exit(1);
    }

    // Forward upstream stderr to our stderr (for debugging)
    this.upstream.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk);
    });

    this.upstream.on('exit', (code) => {
      console.error(chalk.yellow(`[vedis] Upstream exited with code ${code}`));
      process.exit(code ?? 1);
    });

    this.upstream.on('error', (err) => {
      console.error(chalk.red(`[vedis] Upstream error: ${err.message}`));
      process.exit(1);
    });

    // Client → Vedis → Upstream
    const clientParser = new MessageParser((msg) => { void this.handleClientMessage(msg); });
    process.stdin.on('data', (chunk: Buffer) => {
      clientParser.feed(chunk.toString());
    });

    // Upstream → Vedis → Client
    const upstreamParser = new MessageParser((msg) => { void this.handleUpstreamMessage(msg); });
    this.upstream.stdout.on('data', (chunk: Buffer) => {
      upstreamParser.feed(chunk.toString());
    });

    process.stdin.on('end', () => {
      void this.drainAndExit(this.upstream, 0);
    });

    // Graceful shutdown
    const shutdown = () => {
      console.error(chalk.yellow('[vedis] Shutting down...'));
      void this.drainAndExit(this.upstream, 0);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  }

  /**
   * Give the forwarder and the audit stream a bounded window to flush before exiting.
   * Bounded: a cockpit that is unreachable must never hold the proxy open past the timeout
   * (unspooled records survive in the spool either way, so exiting early loses nothing).
   */
  private async drainAndExit(upstream: ChildProcess | null, code: number): Promise<void> {
    try {
      await Promise.all([
        this.forwarder?.close(2000) ?? Promise.resolve(),
        this.audit.drained(),
      ]);
    } catch { /* fail open */ }
    this.audit.close();
    upstream?.kill();
    process.exit(code);
  }

  private async handleClientMessage(msg: JsonRpcMessage): Promise<void> {
    if (!this.upstream?.stdin) return;

    const startTime = Date.now();

    // Handle tools/call requests — the main interception point
    if (isRequest(msg)) {
      const req = msg as JsonRpcRequest;

      // Rate limit check
      if (!this.rateLimiter.allow()) {
        console.error(chalk.red(`[vedis] Rate limited: ${req.method}`));
        this.sendError(req, -32000, 'Rate limit exceeded');
        return;
      }

      if (req.method === 'tools/call') {
        const params = req.params as unknown as ToolCallParams;
        const toolName = params?.name ?? 'unknown';
        let requestRedacted = false;

        // Track pending request
        if (req.id !== undefined) {
          this.pendingRequests.set(req.id, {
            method: req.method,
            tool: toolName,
            startTime,
            args: (params?.arguments ?? undefined) as Record<string, unknown> | undefined,
          });
        }

        // 1. Policy check
        const policyResult = this.policy.check(toolName, params?.arguments);
        if (!policyResult.allowed) {
          console.error(chalk.red(`[vedis] BLOCKED by policy: ${toolName} — ${policyResult.reason}`));
          this.audit.log({
            timestamp: new Date().toISOString(),
            direction: 'request',
            method: req.method,
            tool: toolName,
            blocked: true,
            threats: [],
            filtered: [],
            latencyMs: Date.now() - startTime,
          });
          this.emitCall({
            tool: toolName,
            args: (params?.arguments ?? undefined) as Record<string, unknown> | undefined,
            verdict: 'deny',
            reason: policyResult.reason,
            policyHits: ['policy'],
            latencyMs: Date.now() - startTime,
          });
          this.sendError(req, -32001, `Vedis policy: ${policyResult.reason}`);
          return;
        }

        // 2. Input scanning
        const scanResult = this.scanner.scan(JSON.stringify(params));
        if (scanResult.blocked) {
          const threatNames = scanResult.threats.map(t => t.type).join(', ');
          console.error(chalk.red(`[vedis] BLOCKED by scanner: ${toolName} — threats: ${threatNames} (score: ${scanResult.score})`));
          this.audit.log({
            timestamp: new Date().toISOString(),
            direction: 'request',
            method: req.method,
            tool: toolName,
            blocked: true,
            threats: scanResult.threats,
            filtered: [],
            latencyMs: Date.now() - startTime,
          });
          this.emitCall({
            tool: toolName,
            args: (params?.arguments ?? undefined) as Record<string, unknown> | undefined,
            verdict: 'deny',
            reason: `scanner: ${threatNames}`,
            policyHits: ['scanner'],
            injectionScore: scanResult.score,
            injectionTier: this.tierForScore(scanResult.score),
            latencyMs: Date.now() - startTime,
          });
          this.sendError(req, -32002, `Vedis scanner: potential injection detected (${threatNames})`);
          return;
        }

        if (scanResult.threats.length > 0) {
          console.error(chalk.yellow(`[vedis] WARNING on ${toolName}: ${scanResult.threats.map(t => t.type).join(', ')} (score: ${scanResult.score})`));
        }

        // Deep brain check on the request — only in modes that inspect calls.
        // 'all' = every call; 'flagged' = only when the local scanner flagged;
        // 'external' skips requests (agent intent, not untrusted external content).
        if (this.brain.isEnabled &&
            (this.brain.mode === 'all' ||
              (this.brain.mode === 'flagged' && scanResult.threats.length > 0))) {
          const verdict = await this.brain.analyze({
            direction: 'request',
            payload: params,
            context: { tool: toolName },
          });
          if (verdict?.verdict === 'block') {
            const types = verdict.threats.map((t) => t.type).join(', ') || 'threat detected';
            console.error(chalk.red(`[vedis] BLOCKED by brain: ${toolName} — ${types}`));
            this.audit.log({
              timestamp: new Date().toISOString(),
              direction: 'request',
              method: req.method,
              tool: toolName,
              blocked: true,
              threats: [],
              filtered: [],
              latencyMs: Date.now() - startTime,
            });
            this.emitCall({
              tool: toolName,
              args: (params?.arguments ?? undefined) as Record<string, unknown> | undefined,
              verdict: 'deny',
              reason: `brain: ${types}`,
              policyHits: ['brain'],
              injectionScore: scanResult.score,
              injectionTier: this.tierForScore(scanResult.score),
              latencyMs: Date.now() - startTime,
            });
            this.sendError(req, -32003, `Vedis brain: ${types}`);
            return;
          } else if (verdict?.verdict === 'redact' && verdict.redactions.length > 0) {
            let s = JSON.stringify(req.params);
            for (const r of verdict.redactions) if (r) s = s.split(r).join('[REDACTED]');
            try { req.params = JSON.parse(s); } catch { /* keep original args */ }
            console.error(chalk.magenta(`[vedis] Brain redacted ${verdict.redactions.length} span(s) in ${toolName} args`));
            requestRedacted = true;
          }
        }

        // Log clean request
        this.audit.log({
          timestamp: new Date().toISOString(),
          direction: 'request',
          method: req.method,
          tool: toolName,
          blocked: false,
          threats: scanResult.threats,
          filtered: [],
          latencyMs: Date.now() - startTime,
        });

        // Allowed (possibly flagged) — the record is completed on the response path,
        // which owns the verdict plus the response digest. A request that gets no
        // response never emits a record; the forwarder spool is for transport loss,
        // not for upstreams that never answered.
        if (req.id !== undefined) {
          const p = this.pendingRequests.get(req.id);
          if (p) {
            this.pendingIngestSeed.set(req.id, {
              tool: toolName,
              args: (params?.arguments ?? undefined) as Record<string, unknown> | undefined,
              verdict: scanResult.threats.length > 0 ? 'flag' : 'allow',
              reason: scanResult.threats.length > 0
                ? `scanner: ${scanResult.threats.map((t) => t.type).join(', ')}`
                : '',
              policyHits: scanResult.threats.length > 0 ? ['scanner:flag'] : null,
              injectionScore: scanResult.score,
              injectionTier: this.tierForScore(scanResult.score),
              latencyMs: Date.now() - startTime,
              redacted: requestRedacted,
            });
          }
        }
      } else if (req.id !== undefined) {
        this.pendingRequests.set(req.id, { method: req.method, startTime });
      }
    }

    // Forward to upstream
    this.upstream.stdin.write(serializeMessage(msg));
  }

  private async handleUpstreamMessage(msg: JsonRpcMessage): Promise<void> {
    if (isResponse(msg)) {
      const resp = msg as JsonRpcResponse;
      const pending = resp.id !== undefined ? this.pendingRequests.get(resp.id) : undefined;
      const seed = resp.id !== undefined ? this.pendingIngestSeed.get(resp.id) : undefined;

      if (pending) {
        this.pendingRequests.delete(resp.id);
        if (resp.id !== undefined) this.pendingIngestSeed.delete(resp.id);

        // Tool results only — this is where untrusted EXTERNAL content arrives.
        if (pending.method === 'tools/call' && resp.result) {
          // 3. Fast local output filter (PII / secrets) — always inline.
          const { filtered, result } = this.filter.filterResult(resp.result);
          if (filtered.length > 0) {
            console.error(chalk.magenta(`[vedis] Filtered output for ${pending.tool}: ${filtered.join(', ')}`));
            resp.result = result;
          }

          // 4. Deep brain check (hybrid policy (c)): tool RESPONSES carry the
          // untrusted external content where injections hide. Fail-safe — a null
          // verdict (engine down / timeout / disabled) keeps the locally-filtered
          // result, so a sleeping Strix never hard-breaks the agent.
          // Mode gate: 'flagged' only deep-checks responses the local filter
          // already touched; 'all' / 'external' always deep-check responses.
          const checkResponse =
            this.brain.isEnabled && (this.brain.mode !== 'flagged' || filtered.length > 0);
          let brainBlocked = false;
          let outputRedacted = false;
          if (checkResponse) {
            const verdict = await this.brain.analyze({
              direction: 'response',
              payload: resp.result,
              context: { tool: pending.tool },
            });
            if (verdict?.verdict === 'block') {
              const types = verdict.threats.map((t) => t.type).join(', ') || 'threat detected';
              console.error(chalk.red(`[vedis] BLOCKED by brain: ${pending.tool} — ${types}`));
              brainBlocked = true;
              delete (resp as { result?: unknown }).result;
              resp.error = { code: -32003, message: `Vedis brain blocked tool output (${types})` };
            } else if (verdict?.verdict === 'redact' && verdict.redactions.length > 0) {
              let s = JSON.stringify(resp.result);
              for (const r of verdict.redactions) if (r) s = s.split(r).join('[REDACTED]');
              try { resp.result = JSON.parse(s); } catch { /* keep locally-filtered result */ }
              console.error(chalk.magenta(`[vedis] Brain redacted ${verdict.redactions.length} span(s) in ${pending.tool} output`));
              outputRedacted = true;
            }
          }

          this.audit.log({
            timestamp: new Date().toISOString(),
            direction: 'response',
            method: pending.method,
            tool: pending.tool,
            blocked: brainBlocked,
            threats: [],
            filtered,
            latencyMs: Date.now() - pending.startTime,
          });

          // One ingest record per tool call, carrying the final verdict + response digest.
          this.emitCall({
            tool: pending.tool ?? 'unknown',
            verdict: brainBlocked ? 'deny' : (seed?.verdict ?? 'allow'),
            reason: brainBlocked ? 'brain blocked tool output' : (seed?.reason ?? ''),
            policyHits: brainBlocked ? ['brain:response'] : (seed?.policyHits ?? null),
            latencyMs: Date.now() - pending.startTime,
            redacted: filtered.length > 0 || outputRedacted || Boolean(seed?.redacted),
            responseText: responseTextOf(resp.result),
          });
        }
      }
    }

    // Forward to client
    process.stdout.write(serializeMessage(msg));
  }

  /**
   * Fold a tool call into exactly one ingest record and hand it to the forwarder.
   * Never throws, never awaited: telemetry must not add latency or break a call (§7).
   */
  private emitCall(seed: EventSeed): void {
    if (!this.forwarder) return;
    try {
      this.forwarder.enqueue(buildCallEvent(this.nextEventId(), this.sessionId, seed));
    } catch {
      /* fail open — a telemetry bug must never surface to the agent */
    }
  }

  private nextEventId(): string {
    return `call_${this.sessionId.slice(5, 13)}_${(this.eventSeq += 1)}`;
  }

  /** Coarse injection tier for the record's injection_tier column. */
  private tierForScore(score: number): 'low' | 'medium' | 'high' {
    if (score >= 0.7) return 'high';
    if (score >= 0.4) return 'medium';
    return 'low';
  }

  private sendError(req: JsonRpcRequest, code: number, message: string): void {
    const errorResp: JsonRpcResponse = {
      jsonrpc: '2.0',
      id: req.id!,
      error: { code, message },
    };
    process.stdout.write(serializeMessage(errorResp));
  }
}
