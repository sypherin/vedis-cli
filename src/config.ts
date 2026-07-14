import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import YAML from 'yaml';
import type { VedisConfig } from './types.js';

const DEFAULT_CONFIG: VedisConfig = {
  upstream: {},
  scanner: {
    enabled: true,
    sensitivity: 'medium',
    action: 'block',
  },
  policy: {},
  filter: {
    enabled: true,
    pii: true,
    secrets: true,
  },
  audit: {
    enabled: true,
    jsonl: 'vedis-audit.jsonl',
  },
  rateLimit: {
    requestsPerMinute: 120,
  },
};

export function loadConfig(configPath?: string): VedisConfig {
  const paths = configPath
    ? [configPath]
    : [
        'vedis.config.yaml',
        'vedis.config.yml',
        'vedis.config.json',
        '.vedis.yaml',
        '.vedis.yml',
      ];

  for (const p of paths) {
    const abs = resolve(p);
    if (existsSync(abs)) {
      const raw = readFileSync(abs, 'utf-8');
      const parsed = abs.endsWith('.json') ? JSON.parse(raw) : YAML.parse(raw);
      return mergeConfig(DEFAULT_CONFIG, parsed);
    }
  }

  return DEFAULT_CONFIG;
}

function mergeConfig(defaults: VedisConfig, overrides: Partial<VedisConfig>): VedisConfig {
  const merged = {
    upstream: { ...defaults.upstream, ...overrides.upstream },
    scanner: { ...defaults.scanner, ...overrides.scanner },
    policy: overrides.policy ?? defaults.policy,
    filter: { ...defaults.filter, ...overrides.filter },
    audit: { ...defaults.audit, ...overrides.audit },
    rateLimit: { ...defaults.rateLimit, ...overrides.rateLimit },
    brain: { ...defaults.brain, ...overrides.brain },
    server: overrides.server ?? defaults.server,
  };

  // Validate
  if (merged.scanner?.sensitivity && !['low', 'medium', 'high'].includes(merged.scanner.sensitivity)) {
    console.error(`[vedis] Warning: invalid scanner sensitivity "${merged.scanner.sensitivity}", using "medium"`);
    merged.scanner.sensitivity = 'medium';
  }
  if (merged.scanner?.action && !['block', 'warn', 'log'].includes(merged.scanner.action)) {
    console.error(`[vedis] Warning: invalid scanner action "${merged.scanner.action}", using "block"`);
    merged.scanner.action = 'block';
  }
  if (merged.rateLimit?.requestsPerMinute !== undefined && merged.rateLimit.requestsPerMinute < 0) {
    console.error(`[vedis] Warning: invalid rate limit ${merged.rateLimit.requestsPerMinute}, using 120`);
    merged.rateLimit.requestsPerMinute = 120;
  }

  return merged;
}
