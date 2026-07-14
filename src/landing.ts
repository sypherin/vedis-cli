export function getLandingHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Vedis — The Security Layer MCP Forgot</title>
<meta name="description" content="MCP-native agent security proxy. Prompt injection detection, tool policy enforcement, secret filtering. One config change, zero code changes.">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  :root {
    --bg: #0a0a0f; --surface: #12121a; --surface2: #1a1a26;
    --border: #2a2a3a; --text: #e0e0e8; --text2: #8888a0;
    --accent: #6c5ce7; --accent2: #a29bfe;
    --green: #00e676; --red: #ff5252; --yellow: #ffd740; --blue: #448aff;
  }
  body {
    font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', 'JetBrains Mono', monospace;
    background: var(--bg); color: var(--text);
    min-height: 100vh; line-height: 1.6;
    -webkit-font-smoothing: antialiased;
  }
  a { color: var(--accent2); text-decoration: none; transition: color 0.2s; }
  a:hover { color: white; }

  /* ─── Nav ─── */
  .nav {
    position: fixed; top: 0; left: 0; right: 0; z-index: 100;
    background: rgba(10, 10, 15, 0.85); backdrop-filter: blur(20px);
    border-bottom: 1px solid var(--border);
    padding: 0 32px; height: 60px;
    display: flex; align-items: center; justify-content: space-between;
  }
  .nav-brand { display: flex; align-items: center; gap: 12px; }
  .nav-logo {
    width: 32px; height: 32px; border-radius: 8px;
    background: linear-gradient(135deg, var(--accent), var(--accent2));
    display: flex; align-items: center; justify-content: center;
    font-size: 16px; font-weight: 800; color: white;
  }
  .nav-brand span { font-size: 18px; font-weight: 700; }
  .nav-links { display: flex; gap: 24px; align-items: center; }
  .nav-links a { font-size: 13px; color: var(--text2); }
  .nav-links a:hover { color: var(--text); }
  .nav-cta {
    font-size: 12px; background: var(--accent); color: white !important;
    padding: 8px 16px; border-radius: 6px; font-weight: 600;
  }
  .nav-cta:hover { background: var(--accent2); }

  /* ─── Hero ─── */
  .hero {
    padding: 160px 32px 100px;
    text-align: center;
    position: relative; overflow: hidden;
  }
  .hero::before {
    content: '';
    position: absolute; top: -200px; left: 50%; transform: translateX(-50%);
    width: 800px; height: 600px;
    background: radial-gradient(ellipse, rgba(108, 92, 231, 0.12) 0%, transparent 70%);
    pointer-events: none;
  }
  .hero-badge {
    display: inline-block; font-size: 12px; color: var(--accent2);
    border: 1px solid rgba(108, 92, 231, 0.3);
    padding: 6px 16px; border-radius: 20px; margin-bottom: 32px;
    background: rgba(108, 92, 231, 0.08);
  }
  .hero h1 {
    font-size: clamp(36px, 5vw, 64px); font-weight: 800;
    line-height: 1.1; margin-bottom: 24px;
    background: linear-gradient(135deg, var(--text) 0%, var(--accent2) 100%);
    -webkit-background-clip: text; -webkit-text-fill-color: transparent;
    background-clip: text;
  }
  .hero p {
    font-size: clamp(14px, 1.5vw, 17px); color: var(--text2);
    max-width: 640px; margin: 0 auto 48px; line-height: 1.7;
  }
  .hero-ctas { display: flex; gap: 16px; justify-content: center; flex-wrap: wrap; }
  .cta-install {
    display: flex; align-items: center; gap: 12px;
    background: var(--surface); border: 1px solid var(--border);
    padding: 14px 24px; border-radius: 10px; font-size: 15px;
    font-family: inherit; color: var(--green); cursor: pointer;
    transition: all 0.2s; position: relative;
  }
  .cta-install:hover { border-color: var(--accent); }
  .cta-install .dollar { color: var(--text2); user-select: none; }
  .cta-install .copy-hint {
    font-size: 11px; color: var(--text2); margin-left: 8px;
    opacity: 0; transition: opacity 0.2s;
  }
  .cta-install:hover .copy-hint { opacity: 1; }
  .cta-github {
    display: inline-flex; align-items: center; gap: 8px;
    background: var(--accent); color: white;
    padding: 14px 28px; border-radius: 10px; font-size: 15px;
    font-weight: 600; font-family: inherit;
    transition: all 0.2s; border: 1px solid transparent;
  }
  .cta-github:hover { background: var(--accent2); color: white; }
  .cta-github svg { width: 18px; height: 18px; fill: currentColor; }

  /* ─── Section defaults ─── */
  .section { padding: 80px 32px; max-width: 1100px; margin: 0 auto; }
  .section-label {
    font-size: 12px; color: var(--accent2); text-transform: uppercase;
    letter-spacing: 2px; margin-bottom: 12px; font-weight: 600;
  }
  .section-title {
    font-size: clamp(24px, 3vw, 36px); font-weight: 700; margin-bottom: 16px;
  }
  .section-sub { color: var(--text2); font-size: 15px; max-width: 560px; margin-bottom: 48px; }

  /* ─── Problem Stats ─── */
  .stats-section {
    background: var(--surface);
    border-top: 1px solid var(--border);
    border-bottom: 1px solid var(--border);
  }
  .stats-grid {
    display: grid; grid-template-columns: repeat(3, 1fr);
    max-width: 1100px; margin: 0 auto; padding: 80px 32px;
  }
  .stat-card { text-align: center; padding: 32px 24px; position: relative; }
  .stat-card:not(:last-child)::after {
    content: ''; position: absolute; right: 0; top: 20%; height: 60%;
    width: 1px; background: var(--border);
  }
  .stat-number {
    font-size: clamp(48px, 6vw, 72px); font-weight: 800; line-height: 1;
    margin-bottom: 12px;
  }
  .stat-number.red { color: var(--red); }
  .stat-number.yellow { color: var(--yellow); }
  .stat-number.accent { color: var(--accent2); }
  .stat-desc { font-size: 14px; color: var(--text2); max-width: 240px; margin: 0 auto; }

  /* ─── How It Works ─── */
  .flow { display: flex; align-items: center; justify-content: center; gap: 0; flex-wrap: wrap; }
  .flow-step {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 14px; padding: 32px 28px; text-align: center;
    flex: 0 1 260px; position: relative;
  }
  .flow-step.shield {
    border-color: var(--accent); background: linear-gradient(135deg, #12121a, #1a1028);
    box-shadow: 0 0 40px rgba(108, 92, 231, 0.15);
  }
  .flow-icon {
    font-size: 32px; margin-bottom: 16px; display: block;
  }
  .flow-step h3 { font-size: 15px; font-weight: 600; margin-bottom: 8px; }
  .flow-step p { font-size: 12px; color: var(--text2); }
  .flow-step ul {
    list-style: none; text-align: left; margin-top: 12px;
    font-size: 12px; color: var(--text2);
  }
  .flow-step ul li { padding: 3px 0; }
  .flow-step ul li::before { content: '\\2192\\00a0'; color: var(--accent2); }
  .flow-arrow {
    font-size: 24px; color: var(--text2); padding: 0 20px;
    flex-shrink: 0;
  }

  /* ─── Features Grid ─── */
  .features-grid {
    display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px;
  }
  .feature-card {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 14px; padding: 28px;
    transition: border-color 0.2s, transform 0.2s;
  }
  .feature-card:hover { border-color: var(--accent); transform: translateY(-2px); }
  .feature-icon {
    width: 40px; height: 40px; border-radius: 10px;
    display: flex; align-items: center; justify-content: center;
    font-size: 18px; margin-bottom: 16px;
    background: rgba(108, 92, 231, 0.12); color: var(--accent2);
  }
  .feature-card h3 { font-size: 15px; font-weight: 600; margin-bottom: 8px; }
  .feature-card p { font-size: 13px; color: var(--text2); line-height: 1.6; }

  /* ─── Quick Start ─── */
  .quickstart-block {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 14px; overflow: hidden;
  }
  .quickstart-header {
    display: flex; align-items: center; gap: 8px;
    padding: 14px 20px; background: var(--surface2);
    border-bottom: 1px solid var(--border);
    font-size: 12px; color: var(--text2);
  }
  .quickstart-header .dot-r { width: 12px; height: 12px; border-radius: 50%; background: var(--red); }
  .quickstart-header .dot-y { width: 12px; height: 12px; border-radius: 50%; background: var(--yellow); }
  .quickstart-header .dot-g { width: 12px; height: 12px; border-radius: 50%; background: var(--green); }
  .quickstart-code {
    padding: 24px 28px; font-size: 14px; line-height: 2;
    overflow-x: auto;
  }
  .quickstart-code .comment { color: var(--text2); }
  .quickstart-code .cmd { color: var(--green); }
  .quickstart-code .flag { color: var(--accent2); }
  .quickstart-code .str { color: var(--yellow); }

  /* ─── Pricing ─── */
  .pricing-grid {
    display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px;
  }
  .price-card {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 14px; padding: 36px 28px; display: flex;
    flex-direction: column; position: relative;
  }
  .price-card.featured {
    border-color: var(--accent);
    box-shadow: 0 0 50px rgba(108, 92, 231, 0.12);
  }
  .price-card.featured::before {
    content: 'RECOMMENDED'; position: absolute; top: -12px; left: 50%;
    transform: translateX(-50%); font-size: 10px; font-weight: 700;
    background: var(--accent); color: white; padding: 4px 12px;
    border-radius: 4px; letter-spacing: 1px;
  }
  .price-tier { font-size: 13px; color: var(--text2); text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px; }
  .price-amount { font-size: 36px; font-weight: 800; margin-bottom: 4px; }
  .price-amount span { font-size: 14px; font-weight: 400; color: var(--text2); }
  .price-desc { font-size: 13px; color: var(--text2); margin-bottom: 24px; padding-bottom: 24px; border-bottom: 1px solid var(--border); }
  .price-features { list-style: none; flex: 1; margin-bottom: 28px; }
  .price-features li {
    font-size: 13px; padding: 6px 0; color: var(--text2);
    display: flex; align-items: center; gap: 8px;
  }
  .price-features li::before { content: '\\2713'; color: var(--green); font-weight: 700; font-size: 12px; }
  .price-btn {
    display: block; text-align: center; padding: 14px;
    border-radius: 10px; font-size: 14px; font-weight: 600;
    font-family: inherit; cursor: pointer; transition: all 0.2s;
    border: none;
  }
  .price-btn.primary { background: var(--accent); color: white; }
  .price-btn.primary:hover { background: var(--accent2); }
  .price-btn.outline { background: transparent; border: 1px solid var(--border); color: var(--text2); }
  .price-btn.outline:hover { border-color: var(--accent); color: var(--text); }
  .price-btn.disabled {
    background: var(--surface2); color: var(--text2);
    cursor: not-allowed; opacity: 0.6;
  }

  /* ─── Footer ─── */
  .footer-section {
    border-top: 1px solid var(--border);
    padding: 40px 32px; text-align: center;
  }
  .footer-brand { font-size: 16px; font-weight: 700; margin-bottom: 12px; }
  .footer-links { display: flex; gap: 24px; justify-content: center; margin-bottom: 16px; }
  .footer-links a { font-size: 13px; color: var(--text2); }
  .footer-copy { font-size: 11px; color: var(--text2); }
  .footer-copy a { color: var(--accent2); }

  /* ─── Responsive ─── */
  @media (max-width: 900px) {
    .features-grid { grid-template-columns: repeat(2, 1fr); }
    .pricing-grid { grid-template-columns: 1fr; max-width: 400px; margin-left: auto; margin-right: auto; }
    .price-card.featured::before { display: none; }
  }
  @media (max-width: 700px) {
    .stats-grid { grid-template-columns: 1fr; gap: 0; }
    .stat-card:not(:last-child)::after { display: none; }
    .stat-card:not(:last-child) { border-bottom: 1px solid var(--border); }
    .features-grid { grid-template-columns: 1fr; }
    .flow { flex-direction: column; }
    .flow-arrow { transform: rotate(90deg); padding: 12px 0; }
    .nav-links { display: none; }
    .hero { padding: 120px 20px 60px; }
    .section { padding: 60px 20px; }
  }
</style>
</head>
<body>

<!-- Nav -->
<nav class="nav">
  <div class="nav-brand">
    <div class="nav-logo">V</div>
    <span>Vedis</span>
  </div>
  <div class="nav-links">
    <a href="#how-it-works">How it works</a>
    <a href="#features">Features</a>
    <a href="#quickstart">Quick start</a>
    <a href="#pricing">Pricing</a>
    <a href="https://github.com/sypherin/vedis" target="_blank" class="nav-cta">GitHub</a>
  </div>
</nav>

<!-- Hero -->
<section class="hero">
  <div class="hero-badge">MCP-native security proxy &middot; v0.1</div>
  <h1>The security layer<br>MCP forgot</h1>
  <p>Vedis sits between your AI agents and MCP servers. Detects prompt injection, enforces tool policies, filters secrets. One config change, zero code changes.</p>
  <div class="hero-ctas">
    <div class="cta-install" onclick="navigator.clipboard.writeText('npm install -g vedis')">
      <span class="dollar">$</span> npm install -g vedis
      <span class="copy-hint">click to copy</span>
    </div>
    <a href="https://github.com/sypherin/vedis" target="_blank" class="cta-github">
      <svg viewBox="0 0 16 16"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
      View on GitHub
    </a>
  </div>
</section>

<!-- Problem Stats -->
<section class="stats-section">
  <div class="stats-grid">
    <div class="stat-card">
      <div class="stat-number red">73%</div>
      <div class="stat-desc">of MCP tool calls are vulnerable to prompt injection attacks</div>
    </div>
    <div class="stat-card">
      <div class="stat-number yellow">43%</div>
      <div class="stat-desc">of MCP servers ship with auth or command injection flaws</div>
    </div>
    <div class="stat-card">
      <div class="stat-number accent">0</div>
      <div class="stat-desc">existing MCP-native security proxies &mdash; until now</div>
    </div>
  </div>
</section>

<!-- How It Works -->
<section class="section" id="how-it-works">
  <div class="section-label">Architecture</div>
  <div class="section-title">How it works</div>
  <div class="section-sub">Vedis is a transparent proxy. No SDK, no code changes. Point your agent at Vedis, point Vedis at your MCP server.</div>
  <div class="flow">
    <div class="flow-step">
      <span class="flow-icon">&#9000;</span>
      <h3>Agent</h3>
      <p>Sends MCP tool call<br>via stdio or SSE</p>
    </div>
    <div class="flow-arrow">&#10230;</div>
    <div class="flow-step shield">
      <span class="flow-icon">&#128737;</span>
      <h3>Vedis</h3>
      <p>Scans, filters, enforces</p>
      <ul>
        <li>Injection scanner</li>
        <li>Policy engine</li>
        <li>Output filter</li>
      </ul>
    </div>
    <div class="flow-arrow">&#10230;</div>
    <div class="flow-step">
      <span class="flow-icon">&#9881;</span>
      <h3>MCP Server</h3>
      <p>Receives clean,<br>policy-compliant request</p>
    </div>
  </div>
</section>

<!-- Features -->
<section class="section" id="features">
  <div class="section-label">Capabilities</div>
  <div class="section-title">Everything you need to lock down MCP</div>
  <div class="section-sub">Five middleware modules. All configurable. All optional. Mix and match.</div>
  <div class="features-grid">
    <div class="feature-card">
      <div class="feature-icon">&#128270;</div>
      <h3>Prompt Injection Scanner</h3>
      <p>20+ heuristic patterns for override attempts, role hijacking, encoding tricks. Compound threat scoring with 3 sensitivity levels &mdash; low, medium, high.</p>
    </div>
    <div class="feature-card">
      <div class="feature-icon">&#128220;</div>
      <h3>Tool Policy Engine</h3>
      <p>YAML-based allowlist and blocklist rules. Glob patterns for tool matching. Fine-grained constraints on arguments, methods, and resources.</p>
    </div>
    <div class="feature-card">
      <div class="feature-icon">&#128683;</div>
      <h3>Output Filter</h3>
      <p>PII detection: emails, phone numbers, SSNs, credit cards. Secret scanning: AWS keys, GitHub tokens, Stripe keys, JWTs, PEM certificates.</p>
    </div>
    <div class="feature-card">
      <div class="feature-icon">&#128209;</div>
      <h3>Audit Logger</h3>
      <p>JSONL and SQLite backends. Indexed queries over full request/response trails. Every decision logged with timestamps and threat details.</p>
    </div>
    <div class="feature-card">
      <div class="feature-icon">&#9201;</div>
      <h3>Rate Limiter</h3>
      <p>Sliding window algorithm with configurable per-minute limits. Returns proper JSON-RPC error responses. Prevents runaway agent loops.</p>
    </div>
    <div class="feature-card">
      <div class="feature-icon">&#128200;</div>
      <h3>Live Dashboard</h3>
      <p>Real-time stats and metrics. Interactive injection scanner test. Audit log viewer with filtering. All served from a built-in HTTP server.</p>
    </div>
  </div>
</section>

<!-- Quick Start -->
<section class="section" id="quickstart">
  <div class="section-label">Get started</div>
  <div class="section-title">Three commands. That's it.</div>
  <div class="section-sub">Install globally, generate a config, start the proxy. Your agent connects to Vedis instead of the MCP server directly.</div>
  <div class="quickstart-block">
    <div class="quickstart-header">
      <span class="dot-r"></span>
      <span class="dot-y"></span>
      <span class="dot-g"></span>
      &nbsp;&nbsp;terminal
    </div>
    <pre class="quickstart-code"><span class="comment"># Install Vedis globally</span>
<span class="dollar" style="color:var(--text2)">$</span> <span class="cmd">npm install -g vedis</span>

<span class="comment"># Generate default config</span>
<span class="dollar" style="color:var(--text2)">$</span> <span class="cmd">vedis init</span>

<span class="comment"># Start the security proxy</span>
<span class="dollar" style="color:var(--text2)">$</span> <span class="cmd">vedis proxy</span> <span class="flag">--upstream</span> <span class="str">"npx -y @modelcontextprotocol/server-filesystem /tmp"</span></pre>
  </div>
</section>

<!-- Pricing -->
<section class="section" id="pricing">
  <div class="section-label">Pricing</div>
  <div class="section-title">Start free. Scale when you need to.</div>
  <div class="section-sub">The open source core is fully featured. Pro and Team add cloud-hosted dashboards and advanced detection.</div>
  <div class="pricing-grid">
    <div class="price-card">
      <div class="price-tier">Open Source</div>
      <div class="price-amount">Free</div>
      <div class="price-desc">Everything you need to secure a single agent.</div>
      <ul class="price-features">
        <li>Core proxy (stdio + SSE)</li>
        <li>All 5 middleware modules</li>
        <li>JSONL audit logging</li>
        <li>Built-in dashboard</li>
        <li>Community support</li>
      </ul>
      <a href="https://github.com/sypherin/vedis" target="_blank" class="price-btn primary">Get Started</a>
    </div>
    <div class="price-card featured">
      <div class="price-tier">Pro</div>
      <div class="price-amount">$49<span>/mo</span></div>
      <div class="price-desc">Cloud dashboard and embedding-based detection for teams getting serious.</div>
      <ul class="price-features">
        <li>Everything in Free</li>
        <li>Cloud dashboard</li>
        <li>Embedding-based detection</li>
        <li>100K requests/month</li>
        <li>Webhook alerts</li>
        <li>Email support</li>
      </ul>
      <button class="price-btn disabled" disabled>Coming Soon</button>
    </div>
    <div class="price-card">
      <div class="price-tier">Team</div>
      <div class="price-amount">$199<span>/mo</span></div>
      <div class="price-desc">For organizations running multiple agents at scale.</div>
      <ul class="price-features">
        <li>Everything in Pro</li>
        <li>1M requests/month</li>
        <li>SSO integration</li>
        <li>Team dashboard</li>
        <li>Slack / Discord alerts</li>
        <li>Priority support</li>
      </ul>
      <button class="price-btn disabled" disabled>Coming Soon</button>
    </div>
  </div>
</section>

<!-- Footer -->
<footer class="footer-section">
  <div class="footer-brand">Vedis</div>
  <div class="footer-links">
    <a href="https://github.com/sypherin/vedis" target="_blank">GitHub</a>
    <a href="https://altronis.com" target="_blank">Built by Altronis AI</a>
    <a href="https://vedis.dev" target="_blank">vedis.dev</a>
  </div>
  <div class="footer-copy">&copy; 2026 <a href="https://altronis.com" target="_blank">Altronis AI</a>. Open source under MIT.</div>
</footer>

</body>
</html>`;
}
