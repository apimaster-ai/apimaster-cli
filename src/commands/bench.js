import { Client, extractChatText } from '../lib/client.js';
import { EXIT } from '../lib/exit.js';
import { bar, c, heading, table } from '../lib/ui.js';

export const help = `
apimaster bench — compare latency and throughput across models on one endpoint.

Usage
  apimaster bench <model...> [--runs 3] [--prompt "..."] [--tokens 128] [--json] [--markdown]

Examples
  apimaster bench gpt-5.5 claude-sonnet-4-6 glm-5.3-flash
  apimaster bench --kind chat --top 5          # bench the 5 first chat models on /models
  apimaster bench gpt-5.5 --runs 5 --markdown  # paste-ready table for a PR or issue
`;

const DEFAULT_PROMPT =
  'Write exactly three sentences about why latency matters in developer tools.';

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function runOnce(client, model, prompt, maxTokens) {
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
    const err = new Error(`HTTP ${res.status}: ${body.slice(0, 160)}`);
    err.status = res.status;
    throw err;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let ttft = null;
  let tokens = 0;
  let text = '';
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
          tokens += 1;
          text += delta;
        }
      } catch {
        /* partial frame */
      }
    }
  }
  const total = performance.now() - started;
  // Chunks are a proxy for tokens: close enough for a relative comparison, and it
  // avoids pulling in a tokenizer dependency.
  const tps = tokens > 1 && ttft !== null ? (tokens - 1) / ((total - ttft) / 1000) : null;
  return { ttft, total, chunks: tokens, tps, chars: text.length };
}

export async function run({ config, flags, positionals, out }) {
  const client = new Client({ ...config, debug: flags.debug });
  let models = positionals;

  if (!models.length) {
    const res = await client.listModels();
    const ids = (res.data?.data || []).map((m) => m.id);
    models = ids
      .filter((id) => !/(image|video|sora|seedance|kling|embedding|rerank|whisper|tts|banana|seedream)/i.test(id))
      .slice(0, Number(flags.top ?? 5));
  }
  if (!models.length) {
    out(c.red('No models to benchmark. Pass model ids or check `apimaster models`.'));
    return EXIT.USAGE;
  }

  const runs = Number(flags.runs ?? 3);
  const prompt = flags.prompt || DEFAULT_PROMPT;
  const maxTokens = Number(flags.tokens ?? 128);
  const results = [];

  for (const model of models) {
    const samples = [];
    let error = null;
    for (let i = 0; i < runs; i += 1) {
      try {
        samples.push(await runOnce(client, model, prompt, maxTokens));
      } catch (err) {
        error = err.message;
        break;
      }
    }
    if (!samples.length) {
      results.push({ model, error, ok: false });
      continue;
    }
    const ttfts = samples.map((s) => s.ttft ?? s.total).sort((a, b) => a - b);
    const totals = samples.map((s) => s.total).sort((a, b) => a - b);
    const tpsValues = samples.map((s) => s.tps).filter((v) => v != null);
    results.push({
      model,
      ok: true,
      runs: samples.length,
      ttft_p50: Math.round(percentile(ttfts, 50)),
      ttft_p95: Math.round(percentile(ttfts, 95)),
      total_p50: Math.round(percentile(totals, 50)),
      tps: tpsValues.length
        ? Math.round((tpsValues.reduce((a, b) => a + b, 0) / tpsValues.length) * 10) / 10
        : null,
      error,
    });
  }

  if (flags.json) {
    out(JSON.stringify({ baseUrl: config.baseUrl, runs, prompt, results }, null, 2));
    return EXIT.OK;
  }

  const ok = results.filter((r) => r.ok);
  const maxTtft = Math.max(1, ...ok.map((r) => r.ttft_p50));

  if (flags.markdown) {
    out(`| Model | TTFT p50 | TTFT p95 | Total p50 | chunks/s |`);
    out(`| --- | ---: | ---: | ---: | ---: |`);
    for (const r of results) {
      out(
        r.ok
          ? `| \`${r.model}\` | ${r.ttft_p50} ms | ${r.ttft_p95} ms | ${r.total_p50} ms | ${r.tps ?? '—'} |`
          : `| \`${r.model}\` | failed | | | ${r.error ?? ''} |`
      );
    }
    out('');
    out(
      `_Measured with \`apimaster bench\` against \`${config.baseUrl}\`, ${runs} runs per model, max_tokens=${maxTokens}._`
    );
    return EXIT.OK;
  }

  out(heading(`bench  ${c.gray(`${config.baseUrl} · ${runs} runs · max_tokens=${maxTokens}`)}`));
  out('');
  out(
    table(
      results.map((r) =>
        r.ok
          ? {
              model: c.cyan(r.model),
              ttft: `${r.ttft_p50} ms`,
              p95: c.gray(`${r.ttft_p95} ms`),
              total: c.gray(`${r.total_p50} ms`),
              tps: r.tps ? `${r.tps}` : c.gray('—'),
              chart: bar(r.ttft_p50, maxTtft),
            }
          : { model: c.cyan(r.model), ttft: c.red('failed'), p95: '', total: '', tps: '', chart: c.gray(String(r.error).slice(0, 40)) }
      ),
      [
        { key: 'model', label: 'MODEL' },
        { key: 'ttft', label: 'TTFT p50', align: 'right' },
        { key: 'p95', label: 'p95', align: 'right' },
        { key: 'total', label: 'TOTAL p50', align: 'right' },
        { key: 'tps', label: 'CHUNK/S', align: 'right' },
        { key: 'chart', label: '' },
      ]
    )
  );
  out('');
  out(c.gray('  Throughput is counted in stream chunks, not tokens — use it for relative comparison only.'));
  return ok.length ? EXIT.OK : EXIT.FAILED;
}
