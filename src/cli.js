import { readFile } from 'node:fs/promises';
import { DEFAULTS, maskKey, resolveConfig, saveConfig, CONFIG_PATH } from './lib/config.js';
import { EXIT } from './lib/exit.js';
import { c } from './lib/ui.js';

const COMMANDS = {
  check: () => import('./commands/check.js'),
  models: () => import('./commands/models.js'),
  ping: () => import('./commands/ping.js'),
  verify: () => import('./commands/verify.js'),
  bench: () => import('./commands/bench.js'),
  image: () => import('./commands/image.js'),
  video: () => import('./commands/video.js'),
  use: () => import('./commands/use.js'),
  doctor: () => import('./commands/doctor.js'),
};

const ALIASES = { ls: 'models', list: 'models', config: 'use', diagnose: 'doctor' };

const USAGE = `
${c.bold('apimaster')} — test and configure any OpenAI-compatible LLM endpoint.

${c.bold('Commands')}
  check              Verify a key end to end (models, chat, Anthropic protocol)
  models [pattern]   List models the endpoint actually serves
  ping <model>       One minimal request, with latency (or TTFT with --stream)
  verify <model>     Probe whether a model behaves like what it claims to be
  bench [models...]  Compare TTFT and throughput across models
  image "<prompt>"   Generate an image and save it
  video "<prompt>"   Generate a video, poll the job, download the MP4
  use [tool]         Print or write the config for Claude Code, Codex, Cline, ...
  doctor             Find the usual misconfigurations
  login --key <k>    Store a key in ${CONFIG_PATH}

${c.bold('Global options')}
  --key <key>        API key (else APIMASTER_API_KEY, .env, or the stored config)
  --base-url <url>   OpenAI-compatible base (default ${DEFAULTS.baseUrl})
  --json             Machine-readable output, for CI
  --debug            Log every request
  -h, --help         Help for a command

${c.bold('Examples')}
  apimaster check
  apimaster models --kind image
  apimaster bench gpt-5.5 claude-sonnet-4-6 --markdown
  apimaster use claude-code --write

Works against any OpenAI-compatible gateway — pass --base-url to point it elsewhere.
Docs: ${DEFAULTS.docs}
`;

/**
 * Flags that never take a value. Without this list, `image --no-download "prompt"`
 * would swallow the prompt as the flag's value.
 */
export const BOOLEAN_FLAGS = new Set([
  'json',
  'debug',
  'help',
  'version',
  'stream',
  'markdown',
  'ids',
  'write',
  'async',
  'quiet',
  'no-download',
  'skip-chat',
  'skip-capability',
]);

/** Tiny argv parser: --flag, --flag=value, --flag value, -h. Repeated flags become arrays. */
export function parseArgs(argv) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const body = arg.slice(2);
      const eq = body.indexOf('=');
      let name;
      let value;
      if (eq !== -1) {
        name = body.slice(0, eq);
        value = body.slice(eq + 1);
      } else {
        name = body;
        const next = argv[i + 1];
        if (!BOOLEAN_FLAGS.has(name) && next !== undefined && !next.startsWith('--')) {
          value = next;
          i += 1;
        } else {
          value = true;
        }
      }
      flags[name] = name in flags ? [].concat(flags[name], value) : value;
    } else if (arg === '-h') {
      flags.help = true;
    } else if (arg === '-v') {
      flags.version = true;
    } else {
      positionals.push(arg);
    }
  }
  return { flags, positionals };
}

export async function main(argv) {
  const { flags, positionals } = parseArgs(argv);
  const out = (line = '') => process.stdout.write(`${line}\n`);

  if (flags.version) {
    const pkgUrl = new URL('../package.json', import.meta.url);
    const pkg = JSON.parse(await readFile(pkgUrl, 'utf8'));
    out(pkg.version);
    return;
  }

  const name = ALIASES[positionals[0]] ?? positionals[0];

  if (!name) {
    out(USAGE);
    return;
  }

  if (name === 'login') {
    const key = flags.key || positionals[1];
    if (!key || key === true) {
      out(c.red('Usage: apimaster login --key sk-...'));
      process.exitCode = EXIT.USAGE;
      return;
    }
    const file = saveConfig({
      key,
      baseUrl: flags['base-url'] || DEFAULTS.baseUrl,
      anthropicBaseUrl: flags['anthropic-base-url'] || DEFAULTS.anthropicBaseUrl,
    });
    out(`${c.green('Saved')} ${maskKey(key)} → ${file}`);
    out(c.gray('Next: apimaster check'));
    return;
  }

  const loader = COMMANDS[name];
  if (!loader) {
    out(c.red(`Unknown command "${name}".`));
    out(USAGE);
    process.exitCode = EXIT.USAGE;
    return;
  }

  const mod = await loader();
  if (flags.help) {
    out(mod.help ?? `No help for ${name}.`);
    return;
  }

  const config = resolveConfig(flags);
  if (!config.key && name !== 'use' && name !== 'doctor') {
    out(c.red('No API key found.'));
    out(c.gray('  Set APIMASTER_API_KEY, pass --key, or run: apimaster login --key sk-...'));
    out(c.gray(`  Get a key: https://apimaster.ai/docs/getting-started/api-key`));
    process.exitCode = EXIT.AUTH;
    return;
  }

  process.exitCode = await mod.run({
    config,
    flags,
    positionals: positionals.slice(1),
    out,
  });
}
