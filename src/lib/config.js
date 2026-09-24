import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULTS = {
  baseUrl: 'https://apimaster.ai/v1',
  anthropicBaseUrl: 'https://apimaster.ai',
  docs: 'https://apimaster.ai/docs',
};

export const CONFIG_PATH = path.join(os.homedir(), '.apimaster', 'config.json');

/** Env var names we look at, in priority order. */
const KEY_ENVS = ['APIMASTER_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'];
const URL_ENVS = ['APIMASTER_BASE_URL', 'OPENAI_BASE_URL', 'OPENAI_API_BASE'];

function readFileConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

/** Minimal .env reader — we do not want a dotenv dependency. */
function readDotEnv(cwd = process.cwd()) {
  const out = {};
  try {
    const text = fs.readFileSync(path.join(cwd, '.env'), 'utf8');
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const k = line.slice(0, eq).trim();
      let v = line.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      out[k] = v;
    }
  } catch {
    /* no .env, fine */
  }
  return out;
}

/**
 * Resolve credentials from (highest first): flags → env → .env → ~/.apimaster/config.json.
 * Returns { key, baseUrl, anthropicBaseUrl, keySource }.
 */
export function resolveConfig(flags = {}) {
  const dotenv = readDotEnv();
  const file = readFileConfig();

  let key = flags.key;
  let keySource = key ? '--key' : null;

  if (!key) {
    for (const name of KEY_ENVS) {
      if (process.env[name]) {
        key = process.env[name];
        keySource = `env:${name}`;
        break;
      }
    }
  }
  if (!key) {
    for (const name of KEY_ENVS) {
      if (dotenv[name]) {
        key = dotenv[name];
        keySource = `.env:${name}`;
        break;
      }
    }
  }
  if (!key && file.key) {
    key = file.key;
    keySource = CONFIG_PATH;
  }

  let baseUrl = flags['base-url'];
  if (!baseUrl) {
    for (const name of URL_ENVS) {
      if (process.env[name]) {
        baseUrl = process.env[name];
        break;
      }
    }
  }
  if (!baseUrl) baseUrl = dotenv.APIMASTER_BASE_URL || file.baseUrl || DEFAULTS.baseUrl;

  // Deliberately NOT read from process.env.ANTHROPIC_BASE_URL: that variable usually
  // points at whatever tool the user has configured globally (often Anthropic itself),
  // which would silently contradict --base-url. `doctor` inspects the env var directly.
  const anthropicBaseUrl =
    flags['anthropic-base-url'] || file.anthropicBaseUrl || deriveAnthropicBase(baseUrl);

  return {
    key,
    keySource,
    baseUrl: normalizeBase(baseUrl),
    anthropicBaseUrl: anthropicBaseUrl.replace(/\/+$/, ''),
  };
}

/** Anthropic-compatible base is the site root — the `/v1` suffix must be dropped. */
export function deriveAnthropicBase(openaiBase) {
  return String(openaiBase).replace(/\/+$/, '').replace(/\/v1$/, '');
}

export function normalizeBase(url) {
  return String(url).replace(/\/+$/, '');
}

export function saveConfig(patch) {
  const current = readFileConfig();
  const next = { ...current, ...patch };
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  return CONFIG_PATH;
}

export function maskKey(key) {
  if (!key) return '(none)';
  if (key.length <= 12) return key.slice(0, 3) + '***';
  return `${key.slice(0, 6)}…${key.slice(-4)} (${key.length} chars)`;
}
