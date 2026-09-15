// The ingest call record (INGEST-API.md §3) and the digest helpers it needs.
//
// The proxy sends records UNSEALED — the cockpit seals them (§5, sealBatch) — but every one
// of the 18 hashed columns must still be present on the record, because the cockpit's sealRow
// asserts they exist (a missing hashed column is a 400, not a silent null-hash). So the shape
// lives here, in one place, and the proxy can only supply values for fields it actually has.
import { createHash } from 'node:crypto';

export interface EventSeed {
  tool: string;
  args?: Record<string, unknown> | null;
  verdict: 'allow' | 'deny' | 'flag';
  reason?: string | null;
  policyHits?: string[] | null;
  injectionScore?: number | null;
  injectionTier?: string | null;
  latencyMs: number;
  redacted?: boolean;
  redactedArgs?: Record<string, unknown> | null;
  responseText?: string | null;
  agent?: string | null;
  targetId?: string | null;
}

/** Canonical JSON: keys sorted recursively, matching the cockpit's canonicalJson. */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return '{' + keys.map((k) => JSON.stringify(String(k)) + ':' + canonicalJson((value as Record<string, unknown>)[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/** The value stored in the hashed arguments_sha256 column. Argument text never enters the chain. */
export function hashArgs(args: unknown): string {
  return 'sha256:' + sha256Hex(canonicalJson(args ?? {}));
}

/**
 * Build one ingest record. Populates every hashed column (§5) so the cockpit's sealRow assert
 * passes: a missing key is a 400 at the cockpit, so this function must not omit any of them.
 *
 * `arguments` is expected to be already redacted edge-side (§6); `arguments_sha256` is the
 * digest of the ORIGINAL args, so the 30-day purge stays chain-neutral (§10.4).
 */
export function buildCallEvent(id: string, sessionId: string | null, seed: EventSeed): Record<string, unknown> {
  const responseText = seed.responseText ?? null;

  return {
    id,
    session_id: sessionId,
    tool: seed.tool,
    arguments: seed.redactedArgs ?? seed.args ?? {},
    arguments_sha256: hashArgs(seed.args ?? {}),
    response_digest: responseText === null ? null : 'sha256:' + sha256Hex(responseText),
    response_bytes: responseText === null ? null : Buffer.byteLength(responseText, 'utf8'),
    verdict: seed.verdict,
    reason: seed.reason ?? '',
    policy_hits: seed.policyHits && seed.policyHits.length ? JSON.stringify(seed.policyHits) : null,
    injection_score: seed.injectionScore ?? null,
    injection_tier: seed.injectionTier ?? null,
    redacted: seed.redacted ? 1 : 0,
    latency_ms: seed.latencyMs,
    agent: seed.agent ?? 'unknown',
    target_id: seed.targetId ?? null,
    ts: new Date().toISOString(),
    // Per-row events_lost is null: the loss count belongs to the batch envelope (§7), not to
    // an individual call. It is still written explicitly so the hashed projection is complete.
    events_lost: null,
  };
}