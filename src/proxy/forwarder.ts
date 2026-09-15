// Proxy -> cockpit forwarder. Implements docs/INGEST-API.md §7 (a).
//
// FAIL-OPEN RULE (verbatim, binding):
//   Forwarder is telemetry, so it fails open unconditionally. VEDIS_FAIL_MODE governs
//   policy-engine only and NEVER telemetry.
// A cockpit outage must never stop, slow, or block an agent's tool call. Losing telemetry is
// acceptable; losing the user's agent is not. Loss is loud, not silent: events_lost is counted
// and carried on the next successful batch, and a 401 is surfaced on stderr + the status line.
//
// Records are sent UNSEALED. The proxy cannot seal: prev_hash is part of the hash input, so a
// client-side seal needs a round-trip per call, which defeats batching. The cockpit seals in
// the same transaction it inserts (INGEST-API.md §3 step 4) via chain.sealBatch.
import { appendFileSync, existsSync, readFileSync, renameSync, unlinkSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const FLUSH_INTERVAL_MS = 2000;
const MAX_BATCH_RECORDS = 100;      // §2 records-per-batch cap is 500; 100 keeps batches small
const DEFAULT_QUEUE_CAP = 10000;
const BACKOFF_START_MS = 1000;
const BACKOFF_CAP_MS = 60000;
const SPLIT_FLOOR = 1;              // a single record that still 413s is genuinely unsendable

/**
 * Buffers call records and POSTs them to the cockpit in batches.
 *
 * Everything here is best-effort with respect to the agent: no method this class exposes may
 * throw into the tool-call path, and enqueue() may not await the network.
 */
export class Forwarder {
  private queue: Record<string, unknown>[] = [];
  private timer: NodeJS.Timeout | null = null;
  private sending = false;
  private backoffMs = BACKOFF_START_MS;
  private eventsLost = 0;
  private authFailed = false;
  private authWarned = false;
  private lastError: string | null = null;
  private maxBatch = MAX_BATCH_RECORDS;
  private stopped = false;
  private readonly cap: number;
  private readonly spoolPath: string;

  private readonly endpoint: string;
  private readonly keyId?: string;
  private readonly apiKey?: string;
  private readonly clientVersion: string;
  private readonly proxyId: string;
  private batchSeq = 0;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(
    config: {
      endpoint: string;
      keyId?: string;
      apiKey?: string;
      clientVersion?: string;
      proxyId?: string;
      queueCap?: number;
      spoolPath?: string;
      fetchImpl?: typeof fetch;
      now?: () => number;
    },
  ) {
    this.endpoint = config.endpoint;
    this.keyId = config.keyId;
    this.apiKey = config.apiKey;
    this.clientVersion = config.clientVersion ?? '0.3.0';
    this.proxyId = config.proxyId ?? process.env.VEDIS_PROXY_ID ?? 'proxy-local';
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.cap = config.queueCap ?? DEFAULT_QUEUE_CAP;
    this.spoolPath = config.spoolPath ?? process.env.VEDIS_SPOOL ?? 'vedis-audit-spool.jsonl';
    this.now = config.now ?? (() => Date.now());
  }

  /**
   * Idempotency ledger (§3 replay / §4b). Once a record is accepted by the cockpit it is
   * never enqueued again, which is what makes spool replay after a crash free rather than a
   * source of duplicate rows. Insert rejections are NOT recorded, so a rejected record is
   * genuinely retried. Bounded FIFO so the set can't grow without limit.
   */
  private seenIds = new Set<string>();
  private sentIdOrder: string[] = [];
  private static readonly SENT_ID_CAP = 50000;

  /** Queue one unsealed record. Never blocks, never throws, never awaits the network. */
  enqueue(record: Record<string, unknown>): void {
    if (this.stopped) return;

    const id = this.idOf(record);
    if (id && this.seenIds.has(id)) return; // already delivered — a replay is free

    if (this.queue.length >= this.cap) {
      // Oldest-first overflow per §7(a): the newest context is the most forensically useful, so
      // the oldest record is the one sacrificed. Both halves matter — dropping the shift() result
      // instead of discarding the newcomer would discard the record that was just captured.
      this.queue.shift();
      this.queue.push(record);
      this.eventsLost++;
      if (this.eventsLost % 100 === 1) {
        this.warn(`ingest queue full (cap ${this.cap}) — dropping oldest, events_lost=${this.eventsLost}`);
      }
    } else {
      this.queue.push(record);
    }

    // Spool on enqueue so a crash loses nothing that was already accepted into the queue.
    this.spoolWrite(record);

    if (this.queue.length >= this.maxBatch) void this.flush();
    else this.ensureTimer(FLUSH_INTERVAL_MS);
  }

  /**
   * Flush one batch. Fire-and-forget from the hot path's perspective: the returned promise
   * resolves regardless of transport outcome, so a caller may ignore it.
   */
  async flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.stopped || this.sending || this.queue.length === 0) return;

    const batch = this.queue.splice(0, this.maxBatch);
    if (batch.length === 0) return;

    // §2 envelope. The field is `calls` — the cockpit rejects any other shape with 400, so this
    // shape is not negotiable. `events_lost` rides along so the cockpit can render "N events
    // missing" instead of silently under-reporting (§7); the counter is cleared only on success.
    const body = JSON.stringify({
      batch_id: `batch_${this.now().toString(36)}_${++this.batchSeq}`,
      proxy_id: this.proxyId,
      policy_version: null,
      sent_at: new Date(this.now()).toISOString(),
      events_lost: this.eventsLost,
      calls: batch,
    });

    this.sending = true;
    try {
      const res = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: this.headers(),
        body,
      });

      if (res.status === 201 || res.status === 207) {
        // 207 partial: accept the rest, retry only the rejected ids (§2).
        const rejected = await this.rejectedIds(res);
        const keep: Record<string, unknown>[] = [];
        const accepted: Record<string, unknown>[] = [];
        for (const r of batch) {
          const id = this.idOf(r);
          (id && rejected.includes(id) ? keep : accepted).push(r);
        }
        // The queue may have grown while the request was in flight, so put the records that
        // were NOT accepted back at the head (order preserved). onSuccess() then rewrites the
        // spool to match the queue, so the accepted ones stop being replayed on crash.
        this.queue.unshift(...keep);
        this.markSent(accepted);
        this.onSuccess();
      } else if (res.status === 401) {
        // Stop retrying, keep queueing, be loud. Real notifications are Phase 4, not here.
        this.sending = false;
        this.requeueHead(batch);
        if (!this.authFailed) {
          this.authFailed = true;
          this.authWarned = true;
          this.warn(`ingest auth failed (401) — NOT retrying; check the ingest key. Events keep queueing (queued=${this.queue.length}).`);
        }
      } else if (res.status === 413) {
        // Split and retry (§2). Shrink the batch so the next flush gets smaller.
        this.sending = false;
        if (batch.length > SPLIT_FLOOR) {
          this.requeueHead(batch);
          this.maxBatch = Math.max(SPLIT_FLOOR, Math.floor(this.maxBatch / 2));
        } else {
          // A single record already exceeds the cap — genuinely unsendable, count the loss.
          this.eventsLost += batch.length;
          this.warn(`record exceeds the cockpit batch cap — dropped (events_lost=${this.eventsLost})`);
        }
        this.ensureTimer(FLUSH_INTERVAL_MS);
      } else {
        throw new Error(`HTTP ${res.status}`);
      }
    } catch (err) {
      // Cockpit down / timeout / DNS. Fail open: keep the records, back off.
      this.sending = false;
      this.lastError = err instanceof Error ? err.message : String(err);
      this.requeueHead(batch);
      this.scheduleRetry();
    }
  }

  /**
   * Status line for the proxy's own stderr / status output. A 401 must be visible here —
   * Phase 4 adds real notification, this only guarantees the operator can see it.
   */
  statusLine(): string {
    // Loss is reported ahead of everything else: a queue overflow is forensic loss, and a
    // transport error on top of it must not make the count invisible (§7 "loud, not silent").
    const lost = this.eventsLost > 0 ? `, ${this.eventsLost} lost` : '';
    if (this.authFailed) {
      return `ingest auth failed (401) — retrying paused, queued ${this.queue.length}${lost}`;
    }
    if (this.lastError) return `ingest error: ${this.lastError} — queued ${this.queue.length}${lost}`;
    if (this.eventsLost > 0) return `queued ${this.queue.length}, ${this.eventsLost} lost`;
    return `queued ${this.queue.length}`;
  }

  stats(): {
    queued: number; eventsLost: number; authFailed: boolean;
    backoffMs: number; maxBatch: number; lastError: string | null;
  } {
    return {
      queued: this.queue.length,
      eventsLost: this.eventsLost,
      authFailed: this.authFailed,
      backoffMs: this.backoffMs,
      maxBatch: this.maxBatch,
      lastError: this.lastError,
    };
  }

  /** Test seam: the exact contents of the pending queue, oldest first. */
  drainQueueForTest(): Record<string, unknown>[] {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.sending = false;
    return this.queue.splice(0, this.queue.length);
  }

  /**
   * Replay a spool left by a crashed proxy. Returns how many records were re-enqueued.
   * Called once at proxy start, before any traffic.
   */
  replaySpool(): number {
    if (!existsSync(this.spoolPath)) return 0;
    let raw: string;
    try {
      raw = readFileSync(this.spoolPath, 'utf8');
    } catch { return 0; }

    // Move aside before parsing: a replay that itself crashes must not double-replay.
    const inflight = `${this.spoolPath}.replaying`;
    try { renameSync(this.spoolPath, inflight); } catch { return 0; }

    let n = 0;
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        this.queue.push(JSON.parse(line));
        n++;
      } catch { /* a torn final line is expected after SIGKILL — drop just that line */ }
    }
    try { unlinkSync(inflight); } catch { /* best effort */ }

    // The spool is now represented by the in-memory queue; re-spool it so a second crash
    // still has the whole backlog on disk.
    this.spoolRewrite();
    if (n) this.ensureTimer(FLUSH_INTERVAL_MS);
    return n;
  }

  /** Best-effort drain on shutdown. Bounded so a down cockpit can never hang proxy exit. */
  async close(timeoutMs = 2000): Promise<void> {
    this.stopped = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }

    const deadline = this.now() + timeoutMs;
    let guard = 0;
    while (this.queue.length && this.now() < deadline && !this.authFailed && guard < 50) {
      guard++;
      await this.flush();
      if (this.sending || this.lastError) break;
    }
    // Whatever did not make it stays on disk for the next start.
    this.spoolRewrite();
  }

  // ── internals ────────────────────────────────────────────────────────────

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      'content-type': 'application/json',
      // §2b: required — v1 rejects a batch without it with 400. Without it there is no way to
      // correlate a field-shape bug to the proxy build that sent it.
      'x-vedis-client-version': this.clientVersion,
    };
    if (this.keyId) h['x-vedis-key-id'] = this.keyId as string;
    if (this.apiKey) h.authorization = `Bearer ${this.apiKey}`;
    return h;
  }

  private async rejectedIds(res: Response): Promise<string[]> {
    if (res.status !== 207) return [];
    try {
      const json = (await res.json()) as { rejected?: unknown };
      return Array.isArray(json.rejected) ? (json.rejected as unknown[]).map((r) => typeof r === 'string' ? r : (r as { id?: string })?.id).filter((v): v is string => typeof v === 'string') : [];
    } catch {
      return [];
    }
  }

  private idOf(rec: Record<string, unknown>): string | undefined {
    const v = rec.id;
    return typeof v === 'string' ? v : undefined;
  }

  /**
   * Put records back at the head, preserving order.
   *
   * A batch that was in flight is allowed back in even when it pushes the queue over `cap`:
   * those records already left the queue once and the alternative is counting telemetry we are
   * still holding as "lost". Overflow is charged only against records that genuinely cannot be
   * kept, and always from the oldest end so the newest forensic context survives.
   */
  private requeueHead(records: Record<string, unknown>[]): void {
    if (records.length === 0) return;
    this.queue.unshift(...records);
    const overflow = this.queue.length - this.cap;
    if (overflow > 0) {
      this.queue.splice(0, overflow);
      this.eventsLost += overflow;
    }
  }

  private onSuccess(): void {
    this.sending = false;
    this.backoffMs = BACKOFF_START_MS;
    this.lastError = null;
    this.authFailed = false;
    this.maxBatch = MAX_BATCH_RECORDS;
    // Zeroed only on acceptance, so a failed send can never erase the loss count.
    this.eventsLost = 0;
    // Spool entries for this batch are now durably in the cockpit.
    this.spoolRewrite();
    if (this.queue.length) this.ensureTimer(FLUSH_INTERVAL_MS);
  }

  /** Mark records as delivered so a later spool replay or duplicate enqueue is a no-op. */
  private markSent(records: Record<string, unknown>[]): void {
    for (const r of records) {
      const id = this.idOf(r);
      if (!id || this.seenIds.has(id)) continue;
      this.seenIds.add(id);
      this.sentIdOrder.push(id);
      if (this.sentIdOrder.length > Forwarder.SENT_ID_CAP) {
        const evicted = this.sentIdOrder.shift();
        if (evicted) this.seenIds.delete(evicted);
      }
    }
  }

  /** Exponential backoff with jitter, capped at 60s (§2 transient row). */
  private scheduleRetry(): void {
    if (!this.queue.length || this.stopped) return;
    const jitter = Math.random() * 0.3 * this.backoffMs;
    const delay = Math.min(this.backoffMs + jitter, BACKOFF_CAP_MS);
    this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_CAP_MS);
    this.ensureTimer(delay);
  }

  private ensureTimer(delayMs: number): void {
    if (this.timer || this.stopped) return;
    this.timer = setTimeout(() => { void this.flush(); }, delayMs);
    // A pending flush must never hold the process open — the proxy exits on stdin close.
    this.timer.unref?.();
  }

  private spoolWrite(record: Record<string, unknown>): void {
    try {
      mkdirSync(dirname(this.spoolPath) || '.', { recursive: true });
      appendFileSync(this.spoolPath, JSON.stringify(record) + '\n');
    } catch { /* disk full / read-only: telemetry loss, not fatal */ }
  }

  /** Rewrite the spool to exactly the current queue (after a successful flush). */
  private spoolRewrite(): void {
    try {
      const body = this.queue.map((r) => JSON.stringify(r)).join('\n');
      writeFileSync(this.spoolPath, body ? body + '\n' : '');
    } catch { /* best effort */ }
  }

  private warn(msg: string): void {
    try { process.stderr.write(`[vedis] ${msg}\n`); } catch { /* */ }
  }
}
