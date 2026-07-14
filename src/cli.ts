#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import { loadConfig } from './config.js';
import { StdioProxy } from './proxy/stdio-proxy.js';
import { Scanner } from './middleware/scanner.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));

const program = new Command()
  .name('vedis')
  .description('MCP-native agent security proxy')
  .version(pkg.version);

program
  .command('proxy')
  .description('Start the MCP proxy (stdio mode)')
  .option('-c, --config <path>', 'Config file path')
  .option('--upstream <command>', 'Upstream MCP server command')
  .option('--scanner <mode>', 'Scanner mode: on/off', 'on')
  .option('--sensitivity <level>', 'Scanner sensitivity: low/medium/high', 'medium')
  .option('--action <action>', 'Scanner action: block/warn/log', 'block')
  .action(async (opts) => {
    const config = loadConfig(opts.config);

    if (opts.upstream) {
      const parts = opts.upstream.split(/\s+/);
      config.upstream = { command: parts[0], args: parts.slice(1) };
    }

    if (opts.scanner === 'off') {
      config.scanner = { ...config.scanner!, enabled: false };
    }

    if (opts.sensitivity) {
      config.scanner = { ...config.scanner!, sensitivity: opts.sensitivity };
    }

    if (opts.action) {
      config.scanner = { ...config.scanner!, action: opts.action };
    }

    const proxy = new StdioProxy(config);
    await proxy.start();
  });

program
  .command('scan')
  .description('Scan text for prompt injection (offline test)')
  .argument('<text>', 'Text to scan')
  .option('--sensitivity <level>', 'Sensitivity: low/medium/high', 'medium')
  .action((text, opts) => {
    const scanner = new Scanner({
      enabled: true,
      sensitivity: opts.sensitivity,
      action: 'block',
    });

    const result = scanner.scan(text);
    if (result.threats.length === 0) {
      console.log(chalk.green('Clean — no threats detected'));
    } else {
      console.log(chalk.red(`Score: ${result.score} | Blocked: ${result.blocked}`));
      for (const t of result.threats) {
        console.log(chalk.yellow(`  [${t.severity}] ${t.type}: "${t.match}"`));
      }
    }
  });

program
  .command('serve')
  .description('Start the MCP proxy as an HTTP/SSE server (for Cloud Run)')
  .option('-c, --config <path>', 'Config file path')
  .option('-p, --port <port>', 'Port to listen on', '8080')
  .option('--upstream <command>', 'Upstream MCP server command')
  .action(async (opts) => {
    const config = loadConfig(opts.config);

    if (opts.upstream) {
      const parts = opts.upstream.split(/\s+/);
      config.upstream = { command: parts[0], args: parts.slice(1) };
    }

    config.server = { ...config.server, port: parseInt(opts.port, 10) };

    const { SSEServer } = await import('./proxy/sse-server.js');
    const server = new SSEServer(config);
    server.start();
  });

program
  .command('init')
  .description('Create a vedis.config.yaml in the current directory')
  .action(async () => {
    const template = `# Vedis — MCP Security Proxy Config
# Docs: https://vedis.dev/docs

upstream:
  # The MCP server command to proxy
  command: npx
  args:
    - -y
    - "@modelcontextprotocol/server-filesystem"
    - "/tmp"

scanner:
  enabled: true
  sensitivity: medium  # low | medium | high
  action: block        # block | warn | log

policy:
  tools:
    # allowed: []      # Allowlist (empty = allow all)
    denied:
      - execute_command
      - run_shell
    # constrained:
    #   - name: write_file
    #     rules:
    #       - path_must_match: "src/**"

filter:
  enabled: true
  pii: true
  secrets: true

audit:
  enabled: true
  jsonl: vedis-audit.jsonl
  # sqlite: vedis.db

rateLimit:
  requestsPerMinute: 120

# Hybrid deployment — the deep LLM red-team "brain" on the operator's box.
# Local rules above run inline; this adds deep LLM analysis + the conversational
# runner ("vedis run"). Fail-safe: if the brain is unreachable, local rules stay on.
brain:
  enabled: false                         # set true once you have a token
  url: https://vedis-engine.altronis.sg  # the operator's Vedis engine
  token: ""                              # your per-client token (ask the operator)
  mode: external                         # all | flagged | external
`;
    const outPath = resolve('vedis.config.yaml');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(outPath, template);
    console.log(chalk.green(`Created ${outPath}`));
  });

program
  .command('run')
  .description('Conversational red-team runner — prompt the Strix brain to analyse + red-team (all-in-one)')
  .argument('[prompt...]', 'one-shot prompt (omit for an interactive session)')
  .option('-c, --config <path>', 'Config file path')
  .action(async (promptWords: string[], opts: { config?: string }) => {
    const config = loadConfig(opts.config);
    const brain = config.brain ?? {};
    if (!brain.url || !brain.token) {
      console.error(chalk.red('No brain configured. Set brain.url + brain.token in vedis.config.yaml (run `vedis init` for a template).'));
      process.exit(1);
    }
    const url = brain.url.replace(/\/$/, '');
    const history: Array<{ role: string; content: string }> = [];

    const ask = async (prompt: string): Promise<void> => {
      process.stdout.write(chalk.dim('  …thinking\n'));
      try {
        const res = await fetch(`${url}/agent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${brain.token}` },
          body: JSON.stringify({ prompt, history: history.slice(-12) }),
        });
        if (!res.ok) {
          console.error(chalk.red(`  [brain error ${res.status}] ${(await res.text()).slice(0, 200)}`));
          return;
        }
        const data = (await res.json()) as { reply?: string; error?: string };
        const reply = data.reply ?? data.error ?? '(no reply)';
        console.log('\n' + chalk.cyan('vedis:') + ' ' + reply + '\n');
        history.push({ role: 'user', content: prompt });
        history.push({ role: 'assistant', content: reply });
      } catch (e) {
        console.error(chalk.red(`  [connection error] ${(e as Error).message}`));
      }
    };

    const oneShot = (promptWords ?? []).join(' ').trim();
    if (oneShot) {
      await ask(oneShot);
      return;
    }

    console.log(chalk.bold('Vedis red-team runner') + chalk.dim(` — brain: ${url}`));
    console.log(chalk.dim('Prompt it to analyse content or design/run red-team tests. Type "exit" to quit.\n'));
    const readline = await import('node:readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const loop = (): void => {
      rl.question(chalk.green('you> '), async (line) => {
        const q = line.trim();
        if (q === 'exit' || q === 'quit') {
          rl.close();
          return;
        }
        if (q) await ask(q);
        loop();
      });
    };
    loop();
  });

program.parse();
