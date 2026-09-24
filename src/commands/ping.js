import { Client, describeCompletion } from '../lib/client.js';
import { EXIT, exitCodeForError } from '../lib/exit.js';
import { c, heading, kv, ms } from '../lib/ui.js';

export const help = `
${'apimaster ping'} — send the smallest possible real request and time it.

Reports connect-to-first-byte for non-streaming, and time-to-first-token when --stream is used.

Usage
  apimaster ping <model> [--stream] [--prompt "..."] [--max-tokens 256] [--json]

Examples
  apimaster ping gpt-5.5
  apimaster ping claude-sonnet-4-6 --stream
`;

async function streamPing(client, model, prompt) {
  const started = performance.now();
  const res = await fetch(`${client.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: client.headers(),
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: maxTokens,
      temperature: 0,
      stream: true,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    const err = new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let ttft = null;
  let text = '';
  let chunks = 0;
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const json = JSON.parse(payload);
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) {
          if (ttft === null) ttft = performance.now() - started;
          text += delta;
          chunks += 1;
        }
      } catch {
        /* keep-alive or partial frame */
      }
    }
  }
  const total = performance.now() - started;
  return { ttft, total, text, chunks };
}

export async function run({ config, flags, positionals, out }) {
  const model = positionals[0] || flags.model;
  if (!model) {
    out(c.red('Usage: apimaster ping <model>'));
    return EXIT.USAGE;
  }
  const prompt = flags.prompt || 'Reply with exactly: pong';
  // Reasoning models charge hidden reasoning against max_tokens; a tight cap returns
  // an empty string and makes a healthy endpoint look broken.
  const maxTokens = Number(flags['max-tokens'] ?? 256);
  const client = new Client({ ...config, debug: flags.debug });

  try {
    if (flags.stream) {
      const r = await streamPing(client, model, prompt);
      if (flags.json) {
        out(JSON.stringify({ model, stream: true, ttft_ms: Math.round(r.ttft ?? 0), total_ms: Math.round(r.total), chunks: r.chunks, text: r.text }, null, 2));
        return EXIT.OK;
      }
      out(heading(`ping ${c.cyan(model)} ${c.gray('(streaming)')}`));
      out(kv('time to first token', ms(r.ttft)));
      out(kv('total', ms(r.total)));
      out(kv('chunks', String(r.chunks)));
      out(kv('reply', c.gray(JSON.stringify(r.text.slice(0, 80)))));
      return EXIT.OK;
    }

    const res = await client.chat({
      model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: maxTokens,
      temperature: 0,
    });
    const completion = describeCompletion(res.data);
    const text = completion.text.trim();
    const payload = {
      model,
      ms: Math.round(res.ms),
      echoed_model: res.data?.model ?? null,
      id: res.data?.id ?? null,
      system_fingerprint: res.data?.system_fingerprint ?? null,
      usage: completion.usage,
      reasoning_tokens: completion.reasoningTokens,
      budget_exhausted_by_reasoning: completion.budgetExhaustedByReasoning,
      text,
    };
    if (flags.json) {
      out(JSON.stringify(payload, null, 2));
      return EXIT.OK;
    }
    out(heading(`ping ${c.cyan(model)}`));
    out(kv('latency', ms(res.ms)));
    out(kv('echoed model', payload.echoed_model === model ? c.green(payload.echoed_model) : c.yellow(String(payload.echoed_model))));
    if (payload.usage) {
      const reasoning = completion.reasoningTokens ? `, ${completion.reasoningTokens} reasoning` : '';
      out(kv('tokens', `${payload.usage.prompt_tokens ?? '?'} in / ${payload.usage.completion_tokens ?? '?'} out${reasoning}`));
    }
    if (completion.budgetExhaustedByReasoning) {
      out(kv('reply', c.yellow('(empty — reasoning used the whole budget)')));
      out(c.gray(`  Retry with --max-tokens ${maxTokens * 4} to see the answer.`));
    } else {
      out(kv('reply', c.gray(JSON.stringify(text.slice(0, 80)))));
    }
    return EXIT.OK;
  } catch (err) {
    out(c.red(err.message));
    return exitCodeForError(err);
  }
}
