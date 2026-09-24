import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deriveAnthropicBase } from '../lib/config.js';
import { EXIT } from '../lib/exit.js';
import { c, heading } from '../lib/ui.js';

export const help = `
apimaster doctor — find the configuration mistakes that break OpenAI-compatible gateways.

Checks the environment, the on-disk config of Claude Code / Codex / Gemini CLI,
proxy variables, clock skew and endpoint reachability, then tells you what to change.

Usage
  apimaster doctor [--json]
`;

const findings = [];

function add(level, title, detail, fix) {
  findings.push({ level, title, detail, fix });
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) {
    add('error', 'Node.js too old', `Found ${process.version}`, 'Install Node 18.17 or newer — global fetch is required.');
  } else {
    add('ok', 'Node.js', process.version);
  }
}

function checkKeyHygiene(config) {
  const key = config.key;
  if (!key) {
    add('error', 'No API key found', 'Looked at flags, env, .env and ~/.apimaster/config.json', 'Set APIMASTER_API_KEY, or run: apimaster login --key sk-...');
    return;
  }
  if (/^['"]|['"]$/.test(key)) {
    add('error', 'Key has surrounding quotes', 'The stored value starts or ends with a quote character', 'Remove the quotes — shells keep them inside .env values.');
  }
  if (/\s/.test(key)) {
    add('error', 'Key contains whitespace', 'A space, tab or newline is inside the key', 'Re-copy the key from the console; a trailing newline is the usual culprit.');
  }
  if (key.length < 16) {
    add('warn', 'Key looks short', `${key.length} characters`, 'Confirm you copied the full key.');
  }
  if (findings.every((f) => f.title !== 'Key has surrounding quotes')) {
    add('ok', 'API key present', `from ${config.keySource}`);
  }
}

function checkEnvConflicts(config) {
  const anth = process.env.ANTHROPIC_BASE_URL;
  if (anth && /\/v1\/?$/.test(anth)) {
    add(
      'error',
      'ANTHROPIC_BASE_URL ends with /v1',
      `Found ${anth}`,
      `The Anthropic-compatible base must be the site root. Use ${deriveAnthropicBase(anth)}`
    );
  } else if (anth) {
    add('ok', 'ANTHROPIC_BASE_URL', anth);
  }

  const openai = process.env.OPENAI_BASE_URL || process.env.OPENAI_API_BASE;
  if (openai && !/\/v1\/?$/.test(openai)) {
    add(
      'warn',
      'OPENAI_BASE_URL has no /v1',
      `Found ${openai}`,
      `Most OpenAI SDKs append paths directly. Use ${openai.replace(/\/+$/, '')}/v1`
    );
  } else if (openai) {
    add('ok', 'OPENAI_BASE_URL', openai);
  }

  if (process.env.OPENAI_API_KEY && process.env.APIMASTER_API_KEY && process.env.OPENAI_API_KEY !== process.env.APIMASTER_API_KEY) {
    add(
      'warn',
      'Two different keys in the environment',
      'OPENAI_API_KEY and APIMASTER_API_KEY disagree',
      'Tools pick different variables. Unset the one you are not using for this session.'
    );
  }

  const proxies = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy']
    .filter((k) => process.env[k])
    .map((k) => `${k}=${process.env[k]}`);
  if (proxies.length) {
    add(
      'warn',
      'Proxy variables are set',
      proxies.join(', '),
      "Node's fetch ignores these variables, so requests bypass the proxy entirely and fail as a bare 'fetch failed'. On Node 24+ set NODE_USE_ENV_PROXY=1; otherwise unset them if direct egress works."
    );
  }

  const noProxy = process.env.NO_PROXY || process.env.no_proxy;
  if (proxies.length && noProxy) add('ok', 'NO_PROXY', noProxy);
}

function checkClaudeCode(config) {
  const file = path.join(os.homedir(), '.claude', 'settings.json');
  if (!fs.existsSync(file)) {
    add('info', 'Claude Code settings.json not found', file, 'Only relevant if you use Claude Code. Run: apimaster use claude-code --write');
    return;
  }
  const json = readJson(file);
  if (!json) {
    add('error', 'Claude Code settings.json is not valid JSON', file, 'Fix the syntax — Claude Code silently ignores a broken file.');
    return;
  }
  const env = json.env || {};
  if (!env.ANTHROPIC_BASE_URL) {
    add('info', 'Claude Code is not pointed at a gateway', file, 'Run: apimaster use claude-code --write');
  } else if (/\/v1\/?$/.test(env.ANTHROPIC_BASE_URL)) {
    add(
      'error',
      'Claude Code base URL ends with /v1',
      `${file}: ${env.ANTHROPIC_BASE_URL}`,
      `Change it to ${deriveAnthropicBase(env.ANTHROPIC_BASE_URL)} — this is the single most common misconfiguration.`
    );
  } else {
    add('ok', 'Claude Code base URL', env.ANTHROPIC_BASE_URL);
  }
  if (env.ANTHROPIC_BASE_URL && !env.ANTHROPIC_AUTH_TOKEN && !env.ANTHROPIC_API_KEY) {
    add('error', 'Claude Code has a base URL but no token', file, 'Add ANTHROPIC_AUTH_TOKEN (some builds read ANTHROPIC_API_KEY instead).');
  }
  if (env.ANTHROPIC_AUTH_TOKEN && config.key && env.ANTHROPIC_AUTH_TOKEN !== config.key) {
    add('warn', 'Claude Code token differs from the key this CLI is using', file, 'Expected if intentional; otherwise re-run: apimaster use claude-code --write');
  }
}

function checkCodex() {
  const file = path.join(os.homedir(), '.codex', 'config.toml');
  if (!fs.existsSync(file)) {
    add('info', 'Codex config.toml not found', file, 'Only relevant if you use Codex CLI. Run: apimaster use codex');
    return;
  }
  const text = fs.readFileSync(file, 'utf8');
  const base = text.match(/base_url\s*=\s*"([^"]+)"/)?.[1];
  if (base && !/\/v1\/?$/.test(base)) {
    add('warn', 'Codex base_url has no /v1', `${file}: ${base}`, `Use ${base.replace(/\/+$/, '')}/v1`);
  } else if (base) {
    add('ok', 'Codex base_url', base);
  }
  if (/env_key\s*=/.test(text) === false && /api_key\s*=/.test(text) === false) {
    add('info', 'Codex provider has no key binding', file, 'Add env_key = "APIMASTER_API_KEY" to the provider block.');
  }
}

function checkDotEnvLeak() {
  const env = path.join(process.cwd(), '.env');
  if (!fs.existsSync(env)) return;
  const gitignore = path.join(process.cwd(), '.gitignore');
  const ignored = fs.existsSync(gitignore) && /^\s*\.env\s*$/m.test(fs.readFileSync(gitignore, 'utf8'));
  if (!ignored) {
    add('error', '.env is not gitignored', env, 'Add `.env` to .gitignore before you commit — API keys get leaked this way constantly.');
  } else {
    add('ok', '.env is gitignored', env);
  }
}

async function checkReachability(config) {
  const started = performance.now();
  try {
    const res = await fetch(`${config.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${config.key ?? 'none'}` },
      signal: AbortSignal.timeout(20000),
    });
    const ms = Math.round(performance.now() - started);
    const dateHeader = res.headers.get('date');
    if (dateHeader) {
      const skew = Math.abs(Date.now() - new Date(dateHeader).getTime());
      if (skew > 5 * 60 * 1000) {
        add('warn', 'System clock is off', `${Math.round(skew / 1000)}s from server time`, 'Large clock skew breaks TLS and signed requests. Sync your clock.');
      } else {
        add('ok', 'Clock skew', `${Math.round(skew / 1000)}s`);
      }
    }
    if (res.status === 401) {
      add('error', 'Endpoint reachable but key rejected', `HTTP 401 in ${ms} ms`, 'Recreate the key in the console and try again.');
    } else if (res.ok) {
      add('ok', 'Endpoint reachable', `HTTP ${res.status} in ${ms} ms`);
    } else {
      add('warn', 'Endpoint returned an error', `HTTP ${res.status} in ${ms} ms`, 'Check the base URL path.');
    }
  } catch (err) {
    add(
      'error',
      'Cannot reach the endpoint',
      String(err.message).slice(0, 160),
      'Check DNS, firewall and proxy settings. If a VPN is on, try without it.'
    );
  }
}

export async function run({ config, flags, out }) {
  findings.length = 0;
  checkNode();
  checkKeyHygiene(config);
  checkEnvConflicts(config);
  checkClaudeCode(config);
  checkCodex();
  checkDotEnvLeak();
  await checkReachability(config);

  if (flags.json) {
    out(JSON.stringify({ findings }, null, 2));
    return findings.some((f) => f.level === 'error') ? EXIT.FAILED : EXIT.OK;
  }

  const icon = { ok: c.green('✔'), info: c.blue('·'), warn: c.yellow('!'), error: c.red('✘') };
  out(heading('apimaster doctor'));
  out('');
  for (const f of findings) {
    out(`  ${icon[f.level]} ${c.bold(f.title)} ${c.gray(f.detail ?? '')}`);
    if (f.fix && f.level !== 'ok') out(`      ${c.cyan('→')} ${f.fix}`);
  }
  const errors = findings.filter((f) => f.level === 'error').length;
  const warns = findings.filter((f) => f.level === 'warn').length;
  out('');
  out(
    errors
      ? `  ${c.red(`${errors} problem(s) to fix`)}${warns ? c.gray(`, ${warns} warning(s)`) : ''}`
      : warns
        ? `  ${c.yellow(`${warns} warning(s)`)}, nothing fatal`
        : `  ${c.green('All checks passed.')}`
  );
  return errors ? EXIT.FAILED : EXIT.OK;
}
