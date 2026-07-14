// Vedis hybrid — Brain client (2026-07-14).
//
// The thin client's link to the Strix vedis-engine. After the fast LOCAL rules
// (scanner / policy / filter) run inline, the proxy POSTs each intercepted MCP
// tool call / response here for the DEEP LLM red-team check and enforces the
// returned verdict.
//
// Fail-safe by design: on disabled / timeout / network error / bad response,
// analyze() returns null so the caller falls back to the local rules — a
// sleeping or unreachable Strix brain never hard-breaks the client's agent.
// The heavy analysis + the models stay on Zach's box; only a verdict comes back.

export interface BrainConfig {
  enabled?: boolean;
  url?: string; // e.g. https://vedis-engine.altronis.sg
  token?: string; // per-client bearer token
  timeoutMs?: number; // default 6000
  /**
   * Which traffic gets the deep brain check (latency vs coverage):
   *  - 'all'      every tool call + response
   *  - 'flagged'  only what the local rules already flagged
   *  - 'external' tool responses carrying untrusted content (default)
   */
  mode?: 'all' | 'flagged' | 'external';
}

export interface BrainThreat {
  type: string;
  severity: string;
  detail: string;
}

export interface BrainVerdict {
  verdict: 'allow' | 'block' | 'redact';
  threats: BrainThreat[];
  redactions: string[];
  reasoning: string;
  latencyMs?: number;
  model?: string;
}

export interface BrainItem {
  direction: 'request' | 'response';
  payload: unknown;
  context?: Record<string, unknown>;
}

export class BrainClient {
  private enabled: boolean;
  private url: string;
  private token: string;
  private timeoutMs: number;
  private _mode: 'all' | 'flagged' | 'external';

  constructor(config: BrainConfig = {}) {
    this.enabled = Boolean(config.enabled && config.url && config.token);
    this.url = (config.url ?? '').replace(/\/$/, '');
    this.token = config.token ?? '';
    this.timeoutMs = config.timeoutMs ?? 6000;
    this._mode = config.mode ?? 'external';
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  get mode(): 'all' | 'flagged' | 'external' {
    return this._mode;
  }

  /**
   * Deep-analyze one intercepted item on the Strix brain. Returns the verdict,
   * or null on ANY failure (disabled, timeout, network, non-2xx, unparseable)
   * so the caller falls back to the local rules. Never throws.
   */
  async analyze(item: BrainItem): Promise<BrainVerdict | null> {
    if (!this.enabled) return null;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.url}/analyze`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify(item),
        signal: ac.signal,
      });
      if (!res.ok) return null; // 401 / 502 / etc → fall back to local rules
      const v = (await res.json()) as BrainVerdict;
      if (v && (v.verdict === 'allow' || v.verdict === 'block' || v.verdict === 'redact')) {
        v.threats = v.threats ?? [];
        v.redactions = v.redactions ?? [];
        return v;
      }
      return null;
    } catch {
      return null; // timeout / network error → fall back to local rules
    } finally {
      clearTimeout(timer);
    }
  }
}
