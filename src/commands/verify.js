import { Client, describeCompletion } from '../lib/client.js';
import { EXIT, exitCodeForError } from '../lib/exit.js';
import { c, heading, kv, table } from '../lib/ui.js';

export const help = `
apimaster verify — probe whether a model id behaves like the model it claims to be.

This is a heuristic, not a proof. It runs deterministic probes and reports signals:

  echo          does the response echo back the model id you asked for
  determinism   same prompt at temperature 0, N times — a rotating pool of different
                backends shows up here as divergent completions
  capability    tool calling / JSON schema / logprobs support, which differ sharply
                between an official model and a cheaper stand-in
  self-report   what the model says it is (weakest signal, models routinely get this wrong)

Usage
  apimaster verify <model> [--samples 5] [--max-tokens 512] [--skip-capability] [--json]
`;

const DET_PROMPT =
  'List the first 12 prime numbers separated by single spaces. Output only the numbers.';

const PRIME_ANSWER = '2 3 5 7 11 13 17 19 23 29 31 37';

// Reasoning models spend completion tokens before emitting anything visible. A tight
// budget yields an empty string, which previously scored as a wrong answer and pushed
// healthy models to a "suspicious" verdict. Measured on glm-5.3-flash: 59 of 64 tokens
// went to reasoning and the reply was empty; at 512 the answer was perfect.
const DEFAULT_PROBE_MAX_TOKENS = 512;

function normalize(text) {
  return String(text || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

async function probeDeterminism(client, model, samples, maxTokens) {
  const outputs = [];
  for (let i = 0; i < samples; i += 1) {
    const res = await client.chat({
      model,
      messages: [{ role: 'user', content: DET_PROMPT }],
      max_tokens: maxTokens,
      temperature: 0,
      seed: 7,
    });
    const completion = describeCompletion(res.data);
    outputs.push({
      text: normalize(completion.text),
      ms: res.ms,
      echoed: res.data?.model ?? null,
      fingerprint: res.data?.system_fingerprint ?? null,
      reasoningTokens: completion.reasoningTokens,
      budgetExhausted: completion.budgetExhaustedByReasoning,
    });
  }
  const distinct = new Set(outputs.map((o) => o.text));
  const distinctEchoes = new Set(outputs.map((o) => o.echoed).filter(Boolean));
  const distinctFingerprints = new Set(outputs.map((o) => o.fingerprint).filter(Boolean));
  const latencies = outputs.map((o) => o.ms);
  const mean = latencies.reduce((a, b) => a + b, 0) / latencies.length;
  const spread = Math.max(...latencies) - Math.min(...latencies);
  // `includes`, not `startsWith`: a model that prefixes its answer with prose ("the
  // first 12 primes are: ...") leaves a stray "12" once non-digits are stripped.
  const correct = outputs.filter((o) =>
    o.text.replace(/[^\d ]/g, '').replace(/\s+/g, ' ').trim().includes(PRIME_ANSWER)
  ).length;
  const exhausted = outputs.filter((o) => o.budgetExhausted).length;
  return {
    samples,
    distinctOutputs: distinct.size,
    distinctEchoedModels: [...distinctEchoes],
    distinctFingerprints: [...distinctFingerprints],
    meanMs: Math.round(mean),
    latencySpreadMs: Math.round(spread),
    correctAnswers: correct,
    budgetExhausted: exhausted,
  };
}

async function probeCapability(client, model, name, body, maxTokens) {
  try {
    const res = await client.chat(
      { model, max_tokens: maxTokens, temperature: 0, ...body },
      { timeout: 45000 }
    );
    return { name, supported: true, ms: Math.round(res.ms) };
  } catch (err) {
    return {
      name,
      supported: false,
      status: err.status ?? null,
      error: String(err.message).slice(0, 120),
    };
  }
}

function buildSignals(report, model, samples) {
  const signals = [];
  const det = report.probes.determinism;

  if (det.distinctOutputs === 1) {
    signals.push({
      level: 'good',
      text: `Stable: ${samples}/${samples} identical completions at temperature 0`,
    });
  } else if (det.distinctOutputs <= 2) {
    signals.push({
      level: 'warn',
      text: `${det.distinctOutputs} distinct completions across ${samples} identical requests — mild nondeterminism, common on real endpoints`,
    });
  } else {
    signals.push({
      level: 'bad',
      text: `${det.distinctOutputs} distinct completions across ${samples} identical requests — consistent with a rotating pool of different backends`,
    });
  }

  if (det.budgetExhausted === samples) {
    // Not a quality signal at all: the model never got to answer.
    signals.push({
      level: 'warn',
      text: `All ${samples} runs spent the token budget on reasoning and returned no text — raise --max-tokens to judge quality`,
    });
  } else if (det.correctAnswers + det.budgetExhausted < samples) {
    const judged = samples - det.budgetExhausted;
    signals.push({
      level: det.correctAnswers === 0 ? 'bad' : 'warn',
      text: `Prime-list probe correct in ${det.correctAnswers}/${judged} answered runs — weak for a frontier model`,
    });
  }

  if (det.distinctEchoedModels.length > 1) {
    signals.push({
      level: 'bad',
      text: `Responses echoed more than one model id: ${det.distinctEchoedModels.join(', ')}`,
    });
  } else if (det.distinctEchoedModels[0] && det.distinctEchoedModels[0] !== model) {
    signals.push({
      level: 'warn',
      text: `Requested "${model}" but responses echo "${det.distinctEchoedModels[0]}"`,
    });
  } else if (det.distinctEchoedModels[0] === model) {
    signals.push({ level: 'good', text: 'Echoed model id matches the request' });
  }

  if (det.meanMs > 0 && det.latencySpreadMs > 4 * det.meanMs) {
    signals.push({
      level: 'warn',
      text: `Latency spread ${det.latencySpreadMs} ms around a ${det.meanMs} ms mean — possibly multiple upstreams`,
    });
  }

  for (const cap of report.probes.capabilities ?? []) {
    signals.push({
      level: cap.supported ? 'good' : 'warn',
      text: `${cap.name}: ${cap.supported ? 'supported' : `not supported (${cap.status ?? 'error'})`}`,
    });
  }

  return signals;
}

export async function run({ config, flags, positionals, out }) {
  const model = positionals[0] || flags.model;
  if (!model) {
    out(c.red('Usage: apimaster verify <model>'));
    return EXIT.USAGE;
  }
  const samples = Number(flags.samples ?? 5);
  const maxTokens = Number(flags['max-tokens'] ?? DEFAULT_PROBE_MAX_TOKENS);
  const client = new Client({ ...config, debug: flags.debug });
  const report = {
    model,
    baseUrl: config.baseUrl,
    checkedAt: new Date().toISOString(),
    probes: {},
    signals: [],
  };

  try {
    report.probes.determinism = await probeDeterminism(client, model, samples, maxTokens);

    const self = await client.chat({
      model,
      messages: [
        {
          role: 'user',
          content:
            'Answer in one short line, no punctuation: which model family and version are you? If unsure say unknown.',
        },
      ],
      max_tokens: maxTokens,
      temperature: 0,
    });
    const selfCompletion = describeCompletion(self.data);
    report.probes.selfReport = {
      text: selfCompletion.text.trim().slice(0, 120),
      echoed: self.data?.model ?? null,
      budgetExhaustedByReasoning: selfCompletion.budgetExhaustedByReasoning,
    };

    if (!flags['skip-capability']) {
      report.probes.capabilities = await Promise.all([
        probeCapability(client, model, 'tool_calling', {
          messages: [{ role: 'user', content: 'What is the weather in Paris? Use the tool.' }],
          tools: [
            {
              type: 'function',
              function: {
                name: 'get_weather',
                description: 'Get weather for a city',
                parameters: {
                  type: 'object',
                  properties: { city: { type: 'string' } },
                  required: ['city'],
                },
              },
            },
          ],
        }, maxTokens),
        probeCapability(client, model, 'json_schema', {
          messages: [{ role: 'user', content: 'Return the number 42 in the given schema.' }],
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'answer',
              schema: {
                type: 'object',
                properties: { value: { type: 'number' } },
                required: ['value'],
              },
            },
          },
        }, maxTokens),
        probeCapability(client, model, 'logprobs', {
          messages: [{ role: 'user', content: 'Say ok' }],
          logprobs: true,
          top_logprobs: 2,
        }, maxTokens),
      ]);
    }
  } catch (err) {
    out(c.red(err.message));
    return exitCodeForError(err);
  }

  report.signals = buildSignals(report, model, samples);
  const bad = report.signals.filter((s) => s.level === 'bad').length;
  const warn = report.signals.filter((s) => s.level === 'warn').length;
  report.verdict = bad > 0 ? 'suspicious' : warn > 1 ? 'inconclusive' : 'consistent';

  if (flags.json) {
    out(JSON.stringify(report, null, 2));
    return report.verdict === 'suspicious' ? EXIT.DEGRADED : EXIT.OK;
  }

  const icon = { good: c.green('✔'), warn: c.yellow('!'), bad: c.red('✘') };
  out(heading(`verify ${c.cyan(model)}`));
  out(kv('endpoint', c.gray(config.baseUrl)));
  out(
    kv(
      'self-report',
      c.gray(
        report.probes.selfReport.text ||
          (report.probes.selfReport.budgetExhaustedByReasoning
            ? '(empty — reasoning used the whole budget)'
            : '(empty)')
      ) + c.gray('  ← weak signal')
    )
  );
  out('');
  out(
    table(
      report.signals.map((s) => ({ icon: icon[s.level], text: s.text })),
      [
        { key: 'icon', label: '' },
        { key: 'text', label: 'SIGNAL' },
      ]
    )
  );
  out('');
  const verdictColor = { consistent: c.green, inconclusive: c.yellow, suspicious: c.red }[
    report.verdict
  ];
  out(`  verdict: ${verdictColor(report.verdict)}  ${c.gray('(heuristic — see note below)')}`);
  out(c.gray('  These probes cannot prove a model is authentic. They catch the common failure'));
  out(c.gray('  modes: id mismatch, rotating backends, and missing capabilities.'));
  return report.verdict === 'suspicious' ? EXIT.DEGRADED : EXIT.OK;
}
