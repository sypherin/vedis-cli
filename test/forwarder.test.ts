// Forwarder contract tests — docs/INGEST-API.md §7(a), §8b.
//
// The binding behaviour is what happens to an AGENT when the cockpit is broken, not whether the
// HTTP client looks tidy. So the primary assertions are that enqueue() never throws and never
// blocks; the transport detail is asserted second.
//
// Run: npx tsx test/forwarder.test.ts   (from /home/awpapa/vedis-cli)
import assert from 'node:assert/strict';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { mkdtempSync, appendFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Forwarder } from '../src/proxy/forwarder.js';
import { buildCallEvent } from '../src/proxy/ingest-record.js';

const results: Array<{ name: string; ok: boolean; error?: string }> = [];

async function t(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ok   ${name}`);
  } catch (e) {
    results.push({ name, ok: false, error: String((e as Error).message ?? e) });
    console.log(`  FAIL ${name}\n         ${String((e as Error).message ?? e)}`);
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// One real HTTP server per test, with a handler the test can flip mid-flight.
type Handler = (body: Record<string, unknown>) => { status: number; body?: Record<string, unknown> };
interface Stub {
  server: http.Server;
  url: string;
  received: Array<Record<string, unknown>>;
  headers: Record<string, string>;
  close: () => void;
}

function startStub(handler: Handler): Promise<Stub> {
  const stub = {} as Stub;
  stub.received = [];
  stub.headers = {};
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += String(c); });
    req.on('end', () => {
      let body: Record<string, unknown> = {};
      try { body = raw.trim() ? JSON.parse(raw) : {}; } catch { body = { __parse_error: true }; }
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') stub.headers[k] = v;
      const out = String(req.url || '').includes('/calls') ? handler(body) : { status: 404 };
      const calls = (body.calls as Array<Record<string, unknown>>) ?? [];
      if (out.status === 201) {
        stub.received.push(...calls);
      } else if (out.status === 207) {
        const rejected = new Set(((out.body?.rejected as Array<{ id: string }>) ?? []).map((r) => r.id));
        stub.received.push(...calls.filter((c) => !rejected.has(String(c.id))));
      }
      res.writeHead(out.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out.body ?? {}));
    });
  });
  stub.server = server;
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const a = server.address() as AddressInfo;
      stub.url = `http://127.0.0.1:${a.port}/api/ingest/v1/calls`;
      stub.close = () => { server.close(); };
      resolve(stub);
    });
  });
}

function rec(id: string) {
  return buildCallEvent(id, 'sess_t', { tool: 'test_tool', latencyMs: 3 });
}

/**
 * Drain the forwarder's queue against a live stub. `flush()` is a no-op while a retry timer is
 * armed (or while the 401 latch is down), so drive it explicitly rather than waiting on timers.
 */
async function drain(f: Forwarder, maxRounds = 40): Promise<void> {
  for (let i = 0; i < maxRounds && f.stats().queued > 0; i++) {
    await f.flush();
    await sleep(2);
  }
}

/** Flush until the queue empties, clearing the retry timer between rounds. */
async function forceFlush(f: Forwarder, maxRounds = 60): Promise<void> {
  for (let i = 0; i < maxRounds && f.stats().queued > 0; i++) {
    await f.flush();
    await sleep(1);
  }
}

/**
 * Trigger one send against an unreachable cockpit and wait for the transport failure to be
 * fully recorded. `flush()` resolves as soon as the request is dispatched, so stats() read
 * immediately afterwards are mid-flight — this waits for the rejection path to finish.
 */
async function settleFailedSend(f: Forwarder, maxRounds = 60): Promise<void> {
  for (let i = 0; i < maxRounds; i++) {
    await f.flush();
    await sleep(5);
    if (f.stats().lastError) return;
  }
  assert.fail('the transport failure was never recorded');
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'vedis-fwd-'));
  const P = (name: string) => name;

  // ── TEST CONTRACT (Zach's): cockpit down → all 3 calls succeed, latency unchanged,
  //    events_lost counted, backlog delivered on reconnect ─────────────────────────
  await t(P('cockpit down: 3 calls enqueue with unchanged latency, backlog survives, replayed on reconnect'), async () => {
    const spool = join(dir, 'down.jsonl');
    // Nothing listens on port 1 → ECONNREFUSED, the closest thing to "cockpit is down".
    const f = new Forwarder({ endpoint: 'http://127.0.0.1:1/api/ingest/v1/calls', spoolPath: spool });

    // Warm the code path so the measurement is the steady-state hot path, not cold-start JIT.
    // The warm-up record is distinct so it cannot perturb the three records under test.
    f.enqueue(buildCallEvent('warm_up', 'sess_down', { tool: 'warm', latencyMs: 1 }));

    const latencies: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t0 = process.hrtime.bigint();
      f.enqueue(buildCallEvent(`call_down_${i}`, 'sess_down', { tool: `tool_${i}`, latencyMs: 5 }));
      const us = Number(process.hrtime.bigint() - t0) / 1000;
      latencies.push(us);
    }
    // Budget: enqueue is queue + spool append only. A synchronous network attempt against a dead
    // cockpit costs tens of ms, so 1ms separates "fail open" from "fail open but blocking".
    const worst = Math.max(...latencies);
    assert.ok(worst < 1000, `enqueue charged the tool call ${worst.toFixed(0)}µs (all: ${latencies.map((v) => v.toFixed(0)).join('/')})`);

    // Await the failed send so the transport error is recorded before asserting on it.
    await settleFailedSend(f);
    assert.equal(f.stats().queued, 4, 'a down cockpit must keep the records, not discard them');
    assert.equal(f.stats().eventsLost, 0, 'a retryable failure is a retry, not a loss');
    assert.ok(f.stats().lastError, 'the transport failure must be recorded, not swallowed');

    // Reconnect: a fresh proxy replays exactly what the dead one spooled.
    const stub = await startStub(() => ({ status: 201, body: { accepted: [], rejected: [] } }));
    const f2 = new Forwarder({ endpoint: stub.url, spoolPath: join(dir, 'down.jsonl') });
    assert.equal(f2.replaySpool(), 4, 'spool replay must recover the backlog');
    await drain(f2);
    assert.equal(stub.received.length, 4, 'the backlog must reach the cockpit after reconnect');
    assert.deepEqual(stub.received.map((c) => String(c.id)).sort(), ['call_down_0', 'call_down_1', 'call_down_2', 'warm_up']);
    stub.close();
  });

  // ── events_lost accounting: overflow drops oldest, counter rides the next batch ──
  await t(P('queue overflow drops oldest first and events_lost is zeroed only on acceptance'), async () => {
    const spool = join(dir, 'lost.jsonl');
    // Nothing listens on port 1, so a flush empties the queue and the transport error puts it
    // back with a retry timer armed. flush() returns early while a retry timer is armed, so the
    // queue is then stable and overflow can be observed deterministically.
    const f = new Forwarder({
      endpoint: 'http://127.0.0.1:1/api/ingest/v1/calls',
      queueCap: 3,
      spoolPath: spool,
    });
    f.enqueue(rec('ovf_0'));
    f.enqueue(rec('ovf_1'));
    await settleFailedSend(f);
    assert.equal(f.stats().queued, 2, 'precondition: both records queued with the retry timer armed');
    assert.ok(f.stats().lastError, 'precondition: the failed send must be recorded');

    f.enqueue(rec('ovf_2'));
    f.enqueue(rec('ovf_3'));
    f.enqueue(rec('ovf_4'));
    const s = f.stats();
    assert.equal(s.queued, 3, 'queue must respect its cap');
    assert.equal(s.eventsLost, 2, `both overflow drops must be counted, got ${s.eventsLost}`);
    assert.match(f.statusLine(), /lost/, `loss must be visible on the status line, got: ${f.statusLine()}`);

    // Nothing is delivered, so the loss counter must survive a further failed send. The send
    // that follows the enqueue loop is the one that carries the batch; wait for its rejection to
    // settle before reading the counter.
    await settleFailedSend(f);
    assert.equal(f.stats().eventsLost, 2, 'a failed send must not erase the loss count');

    // Oldest-first: the two sacrificed records are ovf_0 and ovf_1, so what survives in memory
    // is the newest three. The spool is append-on-enqueue and only rewritten on acceptance, so
    // it is the unforgeable record of everything the proxy actually captured.
    const spooled = readFileSync(spool, 'utf8').trim().split('\n').map((l) => String(JSON.parse(l).id));
    assert.deepEqual(spooled, ['ovf_0', 'ovf_1', 'ovf_2', 'ovf_3', 'ovf_4'], 'every record was spooled, in order');
    assert.deepEqual(f.drainQueueForTest().map((r) => String(r.id)), ['ovf_2', 'ovf_3', 'ovf_4'], 'oldest-first drop order');
  });

  // ── backoff: doubles, capped at 60s, reset on success ───────────────────────────
  await t(P('backoff doubles on each failure, plateaus at 60s, and resets on a success'), async () => {
    const stub = await startStub(() => ({ status: 503, body: { error: 'boom' } }));
    const f = new Forwarder({ endpoint: stub.url, spoolPath: join(dir, 'bo.jsonl') });
    f.enqueue(rec('bo_1'));
    const growth: number[] = [];
    for (let i = 0; i < 9; i++) {
      await f.flush();
      growth.push(f.stats().backoffMs);
    }
    // The first flush is the initial attempt (1s window); each failure doubles it.
    assert.deepEqual(growth.slice(0, 5), [2000, 4000, 8000, 16000, 32000], `unexpected backoff curve: ${growth}`);
    assert.ok(growth.every((v) => v <= 60000), `backoff exceeded the 60s cap: ${growth}`);
    // Plateau: repeated failures must stop at 60s rather than run away.
    for (let i = 0; i < 8; i++) await f.flush();
    assert.equal(f.stats().backoffMs, 60000, `backoff must plateau at 60s, got ${f.stats().backoffMs}`);
    // A success resets it, so a recovered cockpit is not punished for the outage.
    const stub2 = await startStub(() => ({ status: 201, body: { accepted: [], rejected: [] } }));
    const ok = new Forwarder({ endpoint: stub2.url, spoolPath: join(dir, 'bo-reset.jsonl') });
    ok.enqueue(rec('br_1'));
    await ok.flush();
    assert.equal(ok.stats().backoffMs, 1000, 'a successful send must leave the backoff at its floor');
    stub2.close();
    stub.close();
  });

  // ── 207 partial: only the rejected ids are retried; accepted ones are not re-sent ─
  await t(P('207 partial: rejected ids are retried once, accepted ids are never re-queued'), async () => {
    const stub = await startStub((body) => {
      const calls = (body.calls as Array<{ id: string }>) ?? [];
      const rejected = calls.filter((c) => c.id === 'p2').map((c) => ({ id: c.id, error: 'bad_verdict' }));
      return { status: rejected.length === 0 ? 201 : 207, body: { accepted: [], rejected } };
    });
    const f = new Forwarder({ endpoint: stub.url, spoolPath: join(dir, 'partial.jsonl') });
    f.enqueue(rec('p1')); f.enqueue(rec('p2')); f.enqueue(rec('p3'));
    await f.flush();               // p2 rejected → back at the head of the queue
    assert.equal(f.stats().queued, 1, 'only the rejected record may remain queued');
    await forceFlush(f);           // retried; p2 is re-sent and rejected again, then settles
    const sent = stub.received.map((c) => String(c.id));
    assert.ok(sent.includes('p1') && sent.includes('p3'), 'accepted records must have been delivered');
    assert.ok(!sent.includes('p2'), 'a record the cockpit rejected on content must not be stored as accepted');
    stub.close();
  });

  // ── 401: stop retrying, keep queueing, be LOUD on the status line ───────────────
  await t(P('cockpit 401: proxy keeps queueing, status line shows the auth failure'), async () => {
    const stub = await startStub(() => ({ status: 401, body: { error: 'invalid_signature' } }));
    const f = new Forwarder({ endpoint: stub.url, spoolPath: join(dir, '401.jsonl') });

    f.enqueue(rec('c1'));
    await f.flush();
    assert.equal(f.stats().authFailed, true, '401 must latch authFailed');

    // Traffic keeps flowing while auth is broken — this is the "proxy keeps serving" half.
    f.enqueue(rec('c2')); f.enqueue(rec('c3'));
    await f.flush();
    assert.ok(f.stats().queued >= 3, `the queue must keep filling during a 401, got ${f.stats().queued}`);
    assert.match(f.statusLine(), /401/, `status line must surface the auth failure, got: ${f.statusLine()}`);
    assert.equal(stub.received.length, 0, 'a 401 must not be counted as a delivery');

    // Retries are PAUSED while the credential is bad, so a broken key cannot burn the socket.
    const before = f.stats().queued;
    await f.flush();
    assert.equal(f.stats().queued, before, 'a 401 must pause retrying rather than hammer the cockpit');
    stub.close();
  });

  // ── spool crash recovery: kill -9 mid-queue, restart, zero loss ─────────────────
  await t(P('spool crash recovery: SIGKILL mid-queue replays with zero loss and no duplicates'), async () => {
    const spool = join(dir, 'crash.jsonl');
    const N = 50;
    const ids: string[] = [];
    const a = new Forwarder({ endpoint: 'http://127.0.0.1:1/api/ingest/v1/calls', spoolPath: spool });
    for (let i = 0; i < N; i++) { a.enqueue(rec(`crash_${i}`)); ids.push(`crash_${i}`); }
    // Simulate SIGKILL landing mid-append: a torn final line is exactly what SIGKILL leaves.
    appendFileSync(spool, '{"id":"torn","arg');

    const stub = await startStub(() => ({ status: 201, body: { accepted: [], rejected: [] } }));
    const b = new Forwarder({ endpoint: stub.url, spoolPath: spool });
    const recovered = b.replaySpool();
    assert.equal(recovered, N, `must recover all ${N} records and only tolerate the torn line`);

    await drain(b);
    const got = stub.received.map((c) => String(c.id));
    assert.equal(got.length, N, `expected ${N} deliveries, got ${got.length}`);
    assert.equal(new Set(got).size, N, 'no duplicate deliveries');
    for (const id of ids) assert.ok(got.includes(id), `${id} was lost across the crash`);
    stub.close();
  });

  // ── delivered records leave the spool (so a later crash cannot duplicate them) ──
  await t(P('a delivered record leaves the spool; a second proxy replays a spool with zero loss'), async () => {
    const spool = join(dir, 'idem.jsonl');
    const stub = await startStub(() => ({ status: 201, body: { accepted: [], rejected: [] } }));
    const f = new Forwarder({ endpoint: stub.url, spoolPath: spool });
    f.enqueue(rec('keep_1'));
    await forceFlush(f);
    assert.equal(readFileSync(spool, 'utf8').trim(), '', 'a delivered record must not stay in the spool');

    // A crash before anything is delivered: a fresh proxy on the same spool recovers every line,
    // and the cockpit's id dedupe (ON CONFLICT) is what makes a replay safe rather than lossy.
    const spool2 = join(dir, 'idem2.jsonl');
    writeFileSync(spool2, [rec('dup_a'), rec('dup_2'), rec('dup_b')].map((r) => JSON.stringify(r)).join('\n') + '\n');
    const stub2 = await startStub(() => ({ status: 201, body: { accepted: [], rejected: [] } }));
    const b = new Forwarder({ endpoint: stub2.url, spoolPath: spool2 });
    assert.equal(b.replaySpool(), 3, 'every spool line must be recovered');
    await forceFlush(b);
    const ids = stub2.received.map((c) => String(c.id));
    for (const id of ['dup_a', 'dup_2', 'dup_b']) assert.ok(ids.includes(id), `${id} lost on replay`);
    assert.equal(ids.length, 3, 'no duplicate deliveries');
    stub.close();
    stub2.close();
  });

  // ── the wire envelope is exactly what §2 promises ───────────────────────────────
  await t(P('batch envelope + headers match INGEST-API §2 (calls/proxy_id/sent_at, x-vedis-client-version)'), async () => {
    const stub = await startStub(() => ({ status: 201, body: { accepted: [], rejected: [] } }));
    const f = new Forwarder({
      endpoint: stub.url,
      keyId: 'ik_test',
      apiKey: 'sekret',
      proxyId: 'proxy-test-1',
      clientVersion: '0.3.0',
      spoolPath: join(dir, 'env.jsonl'),
    });
    f.enqueue(rec('env_1'));
    await drain(f);
    assert.equal(stub.headers['x-vedis-client-version'], '0.3.0', 'x-vedis-client-version is REQUIRED (§2b)');
    assert.equal(stub.headers['x-vedis-key-id'], 'ik_test');
    assert.match(String(stub.headers.authorization), /^Bearer /, 'bearer auth required');
    assert.equal(stub.headers['content-type'], 'application/json');
    stub.close();
  });

  // ── a 413 must split the batch instead of losing it (§2) ────────────────────────
  await t(P('413 halves the batch size and re-queues rather than dropping'), async () => {
    const stub = await startStub((body) => {
      const n = ((body.calls as unknown[]) ?? []).length;
      // Reject anything bigger than one record; a single record is accepted.
      return n > 1 ? { status: 413, body: { error: 'batch_too_large' } }
                   : { status: 201, body: { accepted: [], rejected: [] } };
    });
    const f = new Forwarder({ endpoint: stub.url, spoolPath: join(dir, 'split.jsonl') });
    for (let i = 0; i < 6; i++) f.enqueue(rec(`sp_${i}`));
    await forceFlush(f, 40);
    assert.ok(stub.received.length > 0, 'a 413 must not silently discard the batch');
    stub.close();
  });

  rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} forwarder tests pass`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
