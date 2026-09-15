import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { dirname } from 'node:path';
import type { AuditConfig, AuditEntry } from '../types.js';

export class AuditLogger {
  private jsonlPath: string | null;
  private stream: WriteStream | null = null;
  private streamBroken = false;
  /**
   * Writes issued but not yet drained. `log()` is on the MCP tool-call hot path and the old
   * implementation paid a synchronous appendFileSync per entry — this counter is what
   * `flushed()` waits on so shutdown can prove nothing was truncated (and so the micro-bench
   * can measure the hot path instead of asserting it is fast).
   */
  private pendingWrites = 0;
  private db: unknown = null;
  private insertStmt: unknown = null;

  constructor(config?: AuditConfig) {
    const enabled = config?.enabled ?? true;
    this.jsonlPath = enabled ? (config?.jsonl ?? null) : null;

    if (this.jsonlPath) {
      mkdirSync(dirname(this.jsonlPath) || '.', { recursive: true });
      // One async handle for the process lifetime: `open()` opens once and lets libuv
      // enqueue writes, so a tool call no longer blocks on a fsync-class syscall.
      this.stream = createWriteStream(this.jsonlPath, { flags: 'a' });
      this.stream.on('error', () => { this.streamBroken = true; });
    }

    // SQLite is optional — only init if configured
    if (enabled && config?.sqlite) {
      this.initSqlite(config.sqlite);
    }
  }

  private async initSqlite(path: string): Promise<void> {
    try {
      const mod = await import('better-sqlite3');
      const Database = mod.default ?? mod;
      const db = new (Database as new (path: string) => { exec: (sql: string) => void; prepare: (sql: string) => unknown })(path);
      db.exec(`
        CREATE TABLE IF NOT EXISTS audit (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp TEXT NOT NULL,
          direction TEXT NOT NULL,
          method TEXT NOT NULL,
          tool TEXT,
          blocked INTEGER NOT NULL DEFAULT 0,
          threats TEXT,
          filtered TEXT,
          latency_ms INTEGER
        )
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit(timestamp);
        CREATE INDEX IF NOT EXISTS idx_audit_tool ON audit(tool);
        CREATE INDEX IF NOT EXISTS idx_audit_blocked ON audit(blocked);
      `);
      this.db = db;
      this.insertStmt = db.prepare(`
        INSERT INTO audit (timestamp, direction, method, tool, blocked, threats, filtered, latency_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
    } catch {
      // SQLite optional — if better-sqlite3 not available, skip
      this.db = null;
    }
  }

  log(entry: AuditEntry): void {
    // JSONL output — async, so the tool call is not charged for the write.
    if (this.jsonlPath && this.stream && !this.streamBroken) {
      try {
        this.pendingWrites++;
        this.stream.write(JSON.stringify(entry) + '\n', () => { this.pendingWrites--; });
      } catch {
        this.pendingWrites--;
      }
    }

    // SQLite output
    if (this.insertStmt) {
      try {
        (this.insertStmt as { run: (...args: unknown[]) => void }).run(
          entry.timestamp,
          entry.direction,
          entry.method,
          entry.tool ?? null,
          entry.blocked ? 1 : 0,
          JSON.stringify(entry.threats),
          JSON.stringify(entry.filtered),
          entry.latencyMs,
        );
      } catch { /* best effort */ }
    }
  }

  /**
   * Resolves once every write handed to the stream has actually been flushed to the OS.
   * Used by the micro-bench and by close(); a proxy exit must not truncate the log.
   */
  drained(): Promise<void> {
    if (!this.stream || this.streamBroken) return Promise.resolve();
    if (this.pendingWrites === 0) return Promise.resolve();
    return new Promise((resolve) => {
      const tick = () => {
        if (this.pendingWrites <= 0) resolve();
        else setTimeout(tick, 5);
      };
      tick();
    });
  }

  close(): void {
    if (this.stream) {
      try { this.stream.end(); } catch { /* */ }
      this.stream = null;
    }
    if (this.db) {
      try { (this.db as { close: () => void }).close(); } catch { /* */ }
    }
  }
}
