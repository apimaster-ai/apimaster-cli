import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { parseArgs, BOOLEAN_FLAGS } from '../src/cli.js';
import { classify, family } from '../src/commands/models.js';
import { pickCheapModel } from '../src/commands/check.js';
import { deriveAnthropicBase, normalizeBase, maskKey } from '../src/lib/config.js';
import {
  ApiError,
  describeCompletion,
  extractResponsesText,
  extractChatText,
} from '../src/lib/client.js';
import { width, table } from '../src/lib/ui.js';

describe('parseArgs', () => {
  test('separates positionals from flags', () => {
    const { flags, positionals } = parseArgs(['bench', 'gpt-5.5', 'claude-sonnet-4-6', '--runs', '5']);
    assert.deepEqual(positionals, ['bench', 'gpt-5.5', 'claude-sonnet-4-6']);
    assert.equal(flags.runs, '5');
  });

  test('supports --flag=value', () => {
    const { flags } = parseArgs(['image', '--size=16:9']);
    assert.equal(flags.size, '16:9');
  });

  test('boolean flags do not swallow the next positional', () => {
    const { flags, positionals } = parseArgs(['image', '--no-download', 'a corgi']);
    assert.equal(flags['no-download'], true);
    assert.deepEqual(positionals, ['image', 'a corgi']);
  });

  test('repeated flags collect into an array', () => {
    const { flags } = parseArgs(['image', '--ref', 'a.png', '--ref', 'b.png']);
    assert.deepEqual(flags.ref, ['a.png', 'b.png']);
  });

  test('-- stops flag parsing', () => {
    const { positionals } = parseArgs(['ping', '--', '--not-a-flag']);
    assert.deepEqual(positionals, ['ping', '--not-a-flag']);
  });

  test('every boolean flag is spelled without a value in help examples', () => {
    assert.ok(BOOLEAN_FLAGS.has('json'));
    assert.ok(BOOLEAN_FLAGS.has('stream'));
  });
});

describe('model classification', () => {
  test('recognises media models', () => {
    assert.equal(classify('sora-2-pro'), 'video');
    assert.equal(classify('gpt-image-2'), 'image');
    assert.equal(classify('doubao-seedream-5-0-pro-260628'), 'image');
    assert.equal(classify('midjourney-v8.2'), 'image');
    assert.equal(classify('grok-imagine-video-1.5'), 'video');
    assert.equal(classify('MiniMax-H3'), 'video');
    assert.equal(classify('kling-v3-motion-control'), 'video');
    assert.equal(classify('text-embedding-3-large'), 'embedding');
    assert.equal(classify('gpt-5.5'), 'chat');
  });

  test('maps ids to families', () => {
    assert.equal(family('claude-sonnet-4-6'), 'Anthropic');
    assert.equal(family('deepseek-v3.2'), 'DeepSeek');
    assert.equal(family('midjourney-v8.2'), 'Midjourney');
    assert.equal(family('mimo-v2.6-flash'), 'Xiaomi');
    assert.equal(family('gpt-5.5'), 'OpenAI');
    assert.equal(family('glm-5.2'), 'Zhipu');
  });
});

describe('pickCheapModel', () => {
  test('prefers a small chat model and never picks a media model', () => {
    const picked = pickCheapModel(['sora-2', 'gpt-image-2', 'gpt-5.5', 'glm-5.3-flash']);
    assert.equal(picked, 'glm-5.3-flash');
  });

  test('falls back to the first chat model', () => {
    assert.equal(pickCheapModel(['gpt-5.5', 'claude-opus-4-8']), 'gpt-5.5');
  });

  test('does not treat MiniMax as a "mini" model', () => {
    // Substring matching picked MiniMax-M3 here, which is a large reasoning model:
    // `check` then reported an empty reply and looked broken.
    assert.equal(pickCheapModel(['MiniMax-M3', 'claude-haiku-4-5']), 'claude-haiku-4-5');
  });

  test('skips midjourney ids when picking a chat model', () => {
    assert.equal(pickCheapModel(['midjourney-v8.2', 'gpt-5.5']), 'gpt-5.5');
  });
});

describe('base URL handling', () => {
  test('the Anthropic base drops the /v1 suffix', () => {
    assert.equal(deriveAnthropicBase('https://apimaster.ai/v1'), 'https://apimaster.ai');
    assert.equal(deriveAnthropicBase('https://apimaster.ai/v1/'), 'https://apimaster.ai');
    assert.equal(deriveAnthropicBase('https://apimaster.ai'), 'https://apimaster.ai');
  });

  test('normalizeBase strips trailing slashes only', () => {
    assert.equal(normalizeBase('https://x.dev/v1//'), 'https://x.dev/v1');
  });
});

describe('maskKey', () => {
  test('never reveals the middle of a key', () => {
    const masked = maskKey('sk-abcdefghijklmnopqrstuvwxyz');
    assert.ok(!masked.includes('ghijklmnopqrstu'));
    assert.ok(masked.startsWith('sk-abc'));
  });
});

describe('ApiError', () => {
  test('explains the 404 base-url trap', () => {
    const err = new ApiError(404, { error: { message: 'not found' } });
    assert.match(err.message, /Anthropic-compatible must NOT have \/v1/);
  });

  test('only 429 and 5xx are retryable', () => {
    assert.equal(new ApiError(429, {}).retryable, true);
    assert.equal(new ApiError(503, {}).retryable, true);
    assert.equal(new ApiError(401, {}).retryable, false);
    assert.equal(new ApiError(400, {}).retryable, false);
  });
});

describe('response parsing', () => {
  test('skips a reasoning block before the message', () => {
    const payload = {
      output: [
        { type: 'reasoning', summary: [] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'pong' }] },
      ],
    };
    assert.equal(extractResponsesText(payload), 'pong');
  });

  test('returns null when there is no message item', () => {
    assert.equal(extractResponsesText({ output: [{ type: 'reasoning' }] }), null);
  });

  test('reads chat completions', () => {
    assert.equal(extractChatText({ choices: [{ message: { content: 'hi' } }] }), 'hi');
  });
});

describe('describeCompletion', () => {
  test('flags an empty reply whose budget went to reasoning', () => {
    const payload = {
      choices: [{ message: { content: '' }, finish_reason: 'length' }],
      usage: { completion_tokens: 64, completion_tokens_details: { reasoning_tokens: 59 } },
    };
    const result = describeCompletion(payload);
    assert.equal(result.budgetExhaustedByReasoning, true);
    assert.equal(result.reasoningTokens, 59);
  });

  test('a normal reply is not flagged', () => {
    const payload = {
      choices: [{ message: { content: 'pong' } }],
      usage: { completion_tokens: 5, completion_tokens_details: { reasoning_tokens: 0 } },
    };
    assert.equal(describeCompletion(payload).budgetExhaustedByReasoning, false);
  });

  test('an empty reply with no reasoning tokens is not blamed on reasoning', () => {
    const payload = { choices: [{ message: { content: '' } }], usage: { completion_tokens: 0 } };
    assert.equal(describeCompletion(payload).budgetExhaustedByReasoning, false);
  });
});

describe('ui', () => {
  test('counts CJK characters as double width', () => {
    assert.equal(width('模型'), 4);
    assert.equal(width('ab'), 2);
  });

  test('table aligns columns and renders a header', () => {
    const rendered = table([{ a: 'x', b: 'yy' }], [
      { key: 'a', label: 'A' },
      { key: 'b', label: 'B' },
    ]);
    const lines = rendered.split('\n');
    assert.equal(lines.length, 3);
    assert.match(lines[0], /A/);
  });
});
