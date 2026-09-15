// Before/after micro-bench for the audit hot path (INGEST-API.md §8 latency budget).
//
// Zach's contract says tool-call latency must be *unchanged* with the cockpit down. That claim is
// meaningless unless the local write path is measured, because the audit log sits inside the
// per-call path. This compares the old appendFileSync-per-entry implementation against the
// current long-lived WriteStream, with the real AuditLogger class on one side.
//
// Run: npx tsx test/audit-bench.ts
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditLogger } from '../src/middleware/audit.js';
import type { AuditEntry } from '../src/types.js';

const N = 5000;

function entry(i: number): AuditEntry {
  return {
    timestamp: new Date().toISOString(),
    direction: 'request',
    method: 'tools/call',
    tool: 'filesystem_read_file',
    blocked: i % 17 === 0,
    threats: i % 7 === 0 ? [{ type: 'instruction_override', score: 0.71 }] : [],
    filtered: [],
    latencyMs: 4 + (i % 40),
    sessionId: 'sess_bench',
  } as unknown as AuditEntry;
}

const payload = JSON.stringify(entry(0)) + '\n';

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * N))];
}

function stats(times: number[]): { p50: number; p95: number; p99: number; mean: number } {
  const sorted = [...times].sort((a, b) => a - b);
  const total = sorted.reduce((a, b) => a + b, 0);
  return {
    mean: total / sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
  };
}

function printTable(rows: Array<[string, { mean: number; p50: number; p95: number; p99: number }]>) {
  console.log(`\naudit write path, N=${N} entries (µs, lower is better)\n`);
  console.log('  variant                 mean      p50      p95      p99');
  console.log('  ' + '-'.repeat(56));
  for (const [label, s] of rows) {
    console.log(
      `  ${label.padEnd(20)} ${s.mean.toFixed(1).padStart(7)} ${s.p50.toFixed(1).padStart(8)}` +
      ` ${s.p95.toFixed(1).padStart(8)} ${s.p99.toFixed(1).padStart(8)}`,
    );
  }
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'vedis-bench-'));
  const rows: Array<[string, { mean: number; p50: number; p95: number; p99: number }]> = [];

  // --- BEFORE: appendFileSync per entry (what the hot path used to do) -------------
  const syncPath = join(dir, 'sync.jsonl');
  const syncTimes: number[] = [];
  for (let i = 0; i < N; i++) {
    const t = process.hrtime.bigint();
    appendFileSync(syncPath, payload);
    syncTimes.push(Number(process.hrtime.bigint() - t) / 1000);
  }
  const syncStats = stats(syncTimes);
  rows.push(['appendFileSync', syncStats]);

  // --- AFTER: the real AuditLogger (long-lived async WriteStream) ------------------
  const streamPath = join(dir, 'stream.jsonl');
  const logger = new AuditLogger({ enabled: true, jsonl: streamPath } as never);
  const streamTimes: number[] = [];
  for (let i = 0; i < N; i++) {
    const t = process.hrtime.bigint();
    logger.log(entry(i));
    streamTimes.push(Number(process.hrtime.bigint() - t) / 1000);
  }
  await logger.drained();
  logger.close();
  const streamStats = stats(streamTimes);
  rows.push(['WriteStream (new)', streamStats]);

  printTable(rows);

  const speedup = syncStats.mean / Math.max(streamStats.mean, 0.0001);
  const lines = readFileSync(streamPath, 'utf8').trim().split('\n').length;
  console.log(`\n  per-entry cost: ${syncStats.mean.toFixed(1)}µs -> ${streamStats.mean.toFixed(1)}µs  (${speedup.toFixed(1)}x lower)`);
  console.log(`  p99: ${syncStats.p99.toFixed(1)}µs -> ${streamStats.p99.toFixed(1)}µs`);
  console.log(`  drained file line count: ${lines} (expected ${N})`);
  console.log(lines === N ? '  DRAIN: OK — every handed-off write reached disk' : '  DRAIN: LOSS');

  rmSync(dir, { recursive: true, force: true });
}

main().catch((e) => { console.error(e); process.exit(1); });
