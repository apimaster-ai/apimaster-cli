import { Client } from '../lib/client.js';
import { EXIT, exitCodeForError } from '../lib/exit.js';
import { c, heading, table } from '../lib/ui.js';

export const help = `
${'apimaster models'} — list what this endpoint actually serves right now.

Model catalogs on aggregators change weekly. Never hardcode an id you have not listed.

Usage
  apimaster models [pattern] [--kind chat|image|video|embedding] [--json] [--ids]

Examples
  apimaster models claude
  apimaster models --kind image
  apimaster models --ids | grep gpt
`;

const KINDS = [
  { kind: 'video', re: /(sora|video|kling|seedance|minimax-h|veo|wan|runway|pika)/i },
  { kind: 'image', re: /(image|banana|seedream|flux|midjourney|mj_|dall|imagen|qwen-image)/i },
  { kind: 'embedding', re: /(embedding|embed|rerank|bge|gte)/i },
  { kind: 'audio', re: /(whisper|tts|audio|speech|voice)/i },
];

export function classify(id) {
  for (const { kind, re } of KINDS) if (re.test(id)) return kind;
  return 'chat';
}

export function family(id) {
  const map = [
    [/^gpt|^o\d|^chatgpt|^codex/i, 'OpenAI'],
    [/claude/i, 'Anthropic'],
    [/gemini|imagen|veo/i, 'Google'],
    [/deepseek/i, 'DeepSeek'],
    [/kimi|moonshot/i, 'Moonshot'],
    [/glm|zhipu|chatglm/i, 'Zhipu'],
    [/qwen|tongyi/i, 'Qwen'],
    [/minimax|abab/i, 'MiniMax'],
    [/doubao|seed|seedance|seedream/i, 'ByteDance'],
    [/grok/i, 'xAI'],
    [/llama|mistral|mixtral|gemma|yi-|command/i, 'Open weights'],
    [/sora/i, 'OpenAI'],
    [/kling/i, 'Kuaishou'],
    [/midjourney|niji/i, 'Midjourney'],
    [/mimo/i, 'Xiaomi'],
    [/muse-spark/i, 'Muse'],
  ];
  for (const [re, name] of map) if (re.test(id)) return name;
  return '—';
}

export async function run({ config, flags, positionals, out }) {
  const client = new Client({ ...config, debug: flags.debug });
  let res;
  try {
    res = await client.listModels();
  } catch (err) {
    out(c.red(err.message));
    return exitCodeForError(err);
  }

  const pattern = positionals[0];
  let models = (res.data?.data || []).map((m) => ({
    id: m.id,
    kind: classify(m.id),
    family: family(m.id),
    owned_by: m.owned_by ?? null,
    created: m.created ?? null,
  }));

  if (pattern) {
    const re = new RegExp(pattern, 'i');
    models = models.filter((m) => re.test(m.id));
  }
  if (flags.kind) {
    models = models.filter((m) => m.kind === flags.kind);
  }
  models.sort((a, b) => a.family.localeCompare(b.family) || a.id.localeCompare(b.id));

  if (flags.json) {
    out(JSON.stringify({ count: models.length, ms: Math.round(res.ms), models }, null, 2));
    return EXIT.OK;
  }
  if (flags.ids) {
    models.forEach((m) => out(m.id));
    return EXIT.OK;
  }

  out(heading(`${models.length} models  ${c.gray(`(${Math.round(res.ms)} ms from ${config.baseUrl})`)}`));
  out('');
  out(
    table(
      models.map((m) => ({
        id: m.id,
        kind: m.kind === 'chat' ? c.gray(m.kind) : c.magenta(m.kind),
        family: c.gray(m.family),
      })),
      [
        { key: 'id', label: 'MODEL' },
        { key: 'kind', label: 'KIND' },
        { key: 'family', label: 'FAMILY' },
      ]
    )
  );
  return EXIT.OK;
}
