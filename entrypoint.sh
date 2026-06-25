#!/bin/bash
set -e

# Initialize gbrain on the persistent volume (idempotent — safe to run on every start)
echo "[gbrain] Initializing brain at /data/gbrain..."
gbrain init 2>&1 | head -20
if [ "${PIPESTATUS[0]}" -ne 0 ]; then
  echo "[gbrain] init warning (may be first run on this volume)"
fi

# Lock in conservative search mode — 25x cheaper than tokenmax
gbrain config set search.mode conservative 2>/dev/null || true

# Wire gbrain MCP server into Claude Code settings (atomic write, safe JSON merge)
node -e "
const fs = require('fs');
const dir = '/data/.claude';
const file = dir + '/settings.json';
let cfg = {};
try {
  cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch (e) {
  if (e.code !== 'ENOENT') console.warn('[gbrain] Warning: could not parse existing settings.json:', e.message);
}
cfg.mcpServers = cfg.mcpServers || {};
if (!cfg.mcpServers.gbrain) {
  cfg.mcpServers.gbrain = { command: 'gbrain', args: ['serve'] };
  fs.mkdirSync(dir, { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, file);
  console.log('[gbrain] MCP server registered in Claude Code settings');
} else {
  console.log('[gbrain] MCP server already registered, skipping');
}
"

echo "[gbrain] Running schema migrations..."
gbrain apply-migrations --yes --non-interactive 2>&1 || echo "[gbrain] apply-migrations warning (may be no-op on fresh volume)"

echo "[gbrain] Ready."

# Remove stale @chrysb/alphaclaw npm package plugin path (monorepo migration — one-time cleanup)
# The old template repo pre-installed usage-tracker from node_modules/@chrysb/alphaclaw.
# That path no longer exists; openclaw refuses to start if it's still in plugins.load.paths.
if [ -f "/data/.openclaw/openclaw.json" ]; then
  node -e "
const fs = require('fs');
const file = '/data/.openclaw/openclaw.json';
let cfg;
try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch(e) { process.exit(0); }
const paths = cfg && cfg.plugins && cfg.plugins.load && cfg.plugins.load.paths;
if (!Array.isArray(paths)) process.exit(0);
const stale = paths.filter(function(p){ return p.indexOf('node_modules/@chrysb/alphaclaw') !== -1; });
if (!stale.length) process.exit(0);
cfg.plugins.load.paths = paths.filter(function(p){ return p.indexOf('node_modules/@chrysb/alphaclaw') === -1; });
const tmp = file + '.tmp';
fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
fs.renameSync(tmp, file);
console.log('[entrypoint] Removed stale plugin path(s):', stale.join(', '));
" 2>&1 || true
fi

# Configure OpenClaw browser tool (idempotent — safe to run on every start)
# Set OPENCLAW_BROWSER_DISABLE=1 to skip browser setup (e.g., emergency incident response)
if [ "${OPENCLAW_BROWSER_DISABLE:-0}" = "1" ]; then
  echo "[browser] Disabled via OPENCLAW_BROWSER_DISABLE=1, skipping config"
else
  echo "[browser] Configuring OpenClaw browser tool..."
  node -e "
const fs = require('fs');
const file = '/data/.openclaw/openclaw.json';
let cfg = {};
try {
  cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch (e) {
  if (e.code !== 'ENOENT') console.warn('[browser] Warning: could not parse openclaw.json:', e.message);
}

let changed = false;

if (!cfg.browser) { cfg.browser = {}; changed = true; }
if (cfg.browser.enabled === undefined)   { cfg.browser.enabled = true; changed = true; }
if (!cfg.browser.executablePath)         { cfg.browser.executablePath = '/usr/bin/chromium'; changed = true; }
if (cfg.browser.headless === undefined)  { cfg.browser.headless = true; changed = true; }
if (cfg.browser.noSandbox === undefined) { cfg.browser.noSandbox = true; changed = true; }
if (!cfg.browser.defaultProfile)        { cfg.browser.defaultProfile = 'openclaw'; changed = true; }
if (!cfg.browser.profiles)              { cfg.browser.profiles = {}; changed = true; }
// cdpHost pins CDP listener to loopback — prevents accidental 0.0.0.0 exposure
// color is required by OpenClaw schema; cdpHost is not a valid key
if (!cfg.browser.profiles.openclaw)     { cfg.browser.profiles.openclaw = { cdpPort: 18800, color: '#FF4500' }; changed = true; }

cfg.tools = cfg.tools || {};
cfg.tools.alsoAllow = cfg.tools.alsoAllow || [];
if (!cfg.tools.alsoAllow.includes('browser')) { cfg.tools.alsoAllow.push('browser'); changed = true; }

// browser.enabled=true activates the bundled browser plugin — no plugins.allow entry needed

if (changed) {
  fs.mkdirSync('/data/.openclaw', { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, file);
  console.log('[browser] Config written to /data/.openclaw/openclaw.json');
} else {
  console.log('[browser] Config already present, skipping');
}
"
fi

# Ensure gh config dir exists on the persistent volume before any gh commands
mkdir -p "${GH_CONFIG_DIR:-/data/.config/gh}"

# Auto-authenticate gh CLI via GITHUB_TOKEN only if not already authenticated
# (avoids clobbering a user-OAuth token stored by the dashboard on restart)
if [ -n "$GITHUB_TOKEN" ]; then
  if gh auth status --hostname github.com >/dev/null 2>&1; then
    echo "[gh] Already authenticated, skipping GITHUB_TOKEN login"
  else
    if gh auth login --with-token <<< "$GITHUB_TOKEN"; then
      echo "[gh] Authenticated via GITHUB_TOKEN"
    else
      echo "[gh] Warning: GITHUB_TOKEN present but gh auth login failed (token may lack required scopes)"
    fi
  fi
fi

# Start system cron daemon so /etc/cron.d/openclaw-hourly-sync runs on schedule
/usr/sbin/cron

exec alphaclaw start
