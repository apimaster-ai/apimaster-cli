import { Client, describeCompletion } from '../lib/client.js';
import { maskKey } from '../lib/config.js';
import { EXIT, exitCodeForError } from '../lib/exit.js';
import { c, heading, kv, ms, sym } from '../lib/ui.js';

export const help = `
${'apimaster check'} — verify that a key works, end to end.

Runs four probes: the OpenAI-compatible model list, a minimal chat completion,
the Anthropic-compatible Messages endpoint, and the image endpoint's auth path.

Usage
  apimaster check [--model <id>] [--json] [--quiet]

Options
  --model <id>   Model used for the live chat probe (default: auto-picked from /models)
  --skip-chat    Only check reachability and auth, do not spend tokens
  --json         Machine-readable output
`;

const CHEAP_MODEL_HINTS = ['mini', 'flash', 'haiku', 'lite', 'small', 'turbo', 'air'];

// Reasoning tokens are charged against max_tokens, so probes need real headroom.
const PROBE_MAX_TOKENS = 256;

/**
 * Substring matching is wrong here: "MiniMax-M3" contains "mini" but is a large
 * reasoning model, and picking it made `check` report an empty reply. Require the hint
 * to sit on a token boundary.
 */
function hintRank(id) {
  const lowered = id.toLowerCase();
  return CHEAP_MODEL_HINTS.findIndex((hint) =>
    new RegExp(`(^|[-_.\s])${hint}([-_.\s]|$)`).test(lowered)
  );
}

export function pickCheapModel(ids) {
  const scored = ids
    .filter((id) => !/(image|video|sora|seedance|kling|embedding|rerank|whisper|tts|banana|seedream|midjourney)/i.test(id))
    .map((id) => {
      const hint = hintRank(id);
      return { id, score: hint === -1 ? 99 : hint };
    })
    .sort((a, b) => a.score - b.score || a.id.length - b.id.length);
  return scored[0]?.id ?? ids[0] ?? null;
}

export async function run({ config, flags, out }) {
  const client = new Client({ ...config, timeout: Number(flags.timeout ?? 60_000), debug: flags.debug });
  const result = {
    baseUrl: config.baseUrl,
    anthropicBaseUrl: config.anthropicBaseUrl,
    keySource: config.keySource,
    probes: {},
    ok: false,
  };

  if (!flags.json) {
    out(heading('APIMaster key check'));
    out(kv('OpenAI base', c.cyan(config.baseUrl)));
    out(kv('Anthropic base', c.cyan(config.anthropicBaseUrl)));
    out(kv('Key', `${maskKey(config.key)} ${c.gray(`from ${config.keySource}`)}`));
    out('');
  }

  // Probe 1 — model list. This is the cheapest signal that base URL + key are both right.
  let modelIds = [];
  try {
    const res = await client.listModels();
    modelIds = (res.data?.data || []).map((m) => m.id).filter(Boolean);
    result.probes.models = { ok: true, ms: res.ms, count: modelIds.length };
    if (!flags.json) out(`  ${sym.ok} GET /models         ${ms(res.ms)}  ${c.gray(`${modelIds.length} models`)}`);
  } catch (err) {
    result.probes.models = { ok: false, error: err.message, status: err.status };
    if (!flags.json) out(`  ${sym.fail} GET /models         ${c.red(err.message)}`);
    result.exitCode = exitCodeForError(err);
  }

  // Probe 2 — smallest possible completion. Proves the key can actually spend.
  const model = flags.model || pickCheapModel(modelIds);
  if (!flags['skip-chat'] && model) {
    try {
      const res = await client.chat({
        model,
        messages: [{ role: 'user', content: 'Reply with exactly: ok' }],
        // Generous on purpose: reasoning models burn the budget before emitting text,
        // and a 5-token cap makes a healthy model look broken.
        max_tokens: PROBE_MAX_TOKENS,
        temperature: 0,
      });
      const completion = describeCompletion(res.data);
      const text = completion.text.trim();
      result.probes.chat = {
        ok: true,
        ms: res.ms,
        model,
        reply: text,
        echoedModel: res.data?.model ?? null,
        usage: completion.usage,
        reasoningTokens: completion.reasoningTokens,
        budgetExhaustedByReasoning: completion.budgetExhaustedByReasoning,
      };
      if (!flags.json) {
        const detail = completion.budgetExhaustedByReasoning
          ? c.yellow(`${model} → empty (${completion.reasoningTokens} reasoning tokens used the budget)`)
          : c.gray(`${model} → "${text.slice(0, 20)}"`);
        out(`  ${sym.ok} POST /chat/completions ${ms(res.ms)}  ${detail}`);
      }
    } catch (err) {
      result.probes.chat = { ok: false, model, error: err.message, status: err.status };
      if (!flags.json) out(`  ${sym.fail} POST /chat/completions ${c.red(err.message)}`);
      result.exitCode = result.exitCode ?? exitCodeForError(err);
    }
  }

  // Probe 3 — Anthropic protocol family. This is the #1 source of user confusion
  // (the Anthropic base URL must NOT carry /v1), so it is worth checking separately.
  try {
    const res = await client.anthropicMessages(
      {
        model: flags['claude-model'] || 'claude-sonnet-4-6',
        max_tokens: PROBE_MAX_TOKENS,
        messages: [{ role: 'user', content: 'Reply with exactly: ok' }],
      },
      { timeout: 45_000 }
    );
    const text = res.data?.content?.find((p) => p.type === 'text')?.text ?? '';
    result.probes.anthropic = { ok: true, ms: res.ms, reply: text.trim() };
    if (!flags.json) out(`  ${sym.ok} POST /v1/messages     ${ms(res.ms)}  ${c.gray('Anthropic protocol reachable')}`);
  } catch (err) {
    // A 404 here almost always means the base URL was built wrong, so say that plainly.
    const hint =
      err.status === 404
        ? 'Anthropic base must be the site root without /v1'
        : err.status === 400 || err.status === 404
          ? 'model id may not exist'
          : '';
    result.probes.anthropic = { ok: false, error: err.message, status: err.status, hint };
    if (!flags.json) {
      out(`  ${sym.warn} POST /v1/messages     ${c.yellow(`${err.status ?? 'error'}`)} ${c.gray(hint || err.message.slice(0, 60))}`);
    }
  }

  const required = [result.probes.models, flags['skip-chat'] ? { ok: true } : result.probes.chat].filter(Boolean);
  result.ok = required.every((p) => p?.ok);

  if (flags.json) {
    out(JSON.stringify(result, null, 2));
  } else {
    out('');
    if (result.ok) {
      out(`  ${c.green('Key works.')} ${c.gray(`Try: apimaster models | apimaster ping ${model ?? '<model>'}`)}`);
    } else {
      out(`  ${c.red('Key check failed.')} ${c.gray('See https://apimaster.ai/docs/getting-started/api-key')}`);
    }
  }

  return result.ok ? EXIT.OK : (result.exitCode ?? EXIT.FAILED);
}
