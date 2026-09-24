import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '../lib/client.js';
import { EXIT, exitCodeForError } from '../lib/exit.js';
import { c, heading, kv } from '../lib/ui.js';

export const help = `
apimaster image — generate an image and save it locally.

Usage
  apimaster image "<prompt>" [options]

Options
  --model <id>        default: gpt-image-2
  --size <ratio>      1:1, 16:9, 9:16, 4:3, 3:4, 21:9 ... or pixels like 1881x836
  --resolution <r>    1k | 2k | 4k   (default 1k)
  --n <count>         number of images
  --ref <url>         reference image for image-to-image; repeatable (max 16)
  --mask <url>        mask URL for inpainting (same size as the first reference)
  --async             submit to the async endpoint and poll (use this for 2k/4k)
  --out <dir>         download directory (default ./out)
  --no-download       print URLs only
  --json              machine-readable output

Notes
  Advanced parameters (quality, background, output_format) narrow which upstream
  channels can serve the request and can route you to a more expensive one.
  Send only what you actually need.
`;

// Long jobs need long timeouts. These match the documented guidance per resolution tier.
const SYNC_TIMEOUT = { '1k': 200000, '2k': 320000, '4k': 620000 };

async function download(url, dir, name, key) {
  fs.mkdirSync(dir, { recursive: true });
  const res = await fetch(url, { headers: url.includes('apimaster') ? { Authorization: `Bearer ${key}` } : {} });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const ext = (url.split('?')[0].match(/\.(png|jpe?g|webp)$/i)?.[1] || 'png').toLowerCase();
  const file = path.join(dir, `${name}.${ext}`);
  fs.writeFileSync(file, buf);
  return { file, bytes: buf.length };
}

async function pollImageTask(client, taskId, model, { onTick } = {}) {
  await delay(12000);
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const res = await client.imageTask(taskId, model);
    const data = res.data?.data ?? res.data;
    const status = data?.status;
    onTick?.(status, attempt);
    if (status === 'completed') return data;
    if (['failed', 'error', 'cancelled'].includes(status)) {
      throw new Error(`task ${status}: ${JSON.stringify(res.data).slice(0, 300)}`);
    }
    await delay(4000);
  }
  throw new Error('gave up polling after ~13 minutes');
}

export async function run({ config, flags, positionals, out }) {
  const prompt = positionals.join(' ').trim() || flags.prompt;
  if (!prompt) {
    out(c.red('Usage: apimaster image "a corgi astronaut on the moon" --size 16:9'));
    return EXIT.USAGE;
  }
  const model = flags.model || 'gpt-image-2';
  const resolution = flags.resolution || '1k';
  const refs = [].concat(flags.ref ?? []).filter(Boolean);

  const body = { model, prompt };
  if (flags.size) body.size = flags.size;
  if (flags.resolution) body.resolution = resolution;
  if (flags.n) body.n = Number(flags.n);
  if (refs.length) body.image_urls = refs;
  if (flags.mask) body.mask_url = flags.mask;
  if (flags.quality) body.quality = flags.quality;

  const client = new Client({ ...config, debug: flags.debug });
  const started = performance.now();

  if (!flags.json) {
    out(heading(`image ${c.cyan(model)}`));
    out(kv('prompt', c.gray(prompt.slice(0, 70))));
    if (body.size) out(kv('size', body.size));
    out(kv('resolution', resolution));
    if (refs.length) out(kv('references', `${refs.length}`));
    out(kv('mode', flags.async ? 'async + poll' : 'sync'));
    out('');
  }

  try {
    let urls = [];
    if (flags.async) {
      const submit = await client.images(body, { async: true, timeout: 60000 });
      const taskId = submit.data?.data?.[0]?.task_id;
      if (!taskId) throw new Error(`no task_id in response: ${JSON.stringify(submit.data).slice(0, 200)}`);
      if (!flags.json) out(`  ${c.gray('task')} ${taskId}`);
      const done = await pollImageTask(client, taskId, model, {
        onTick: (status, i) => {
          if (!flags.json && i % 5 === 0) out(c.gray(`  … ${status ?? 'pending'}`));
        },
      });
      urls = (done?.result?.images ?? []).flatMap((img) => img.url ?? []);
    } else {
      const res = await client.images(body, { timeout: SYNC_TIMEOUT[resolution] ?? 200000 });
      urls = (res.data?.data ?? []).map((d) => d.url).filter(Boolean);
    }

    const elapsed = Math.round(performance.now() - started);
    const saved = [];
    if (!flags['no-download']) {
      const dir = flags.out || 'out';
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      for (const [i, url] of urls.entries()) {
        saved.push(await download(url, dir, `${model}-${stamp}-${i + 1}`, config.key));
      }
    }

    if (flags.json) {
      out(JSON.stringify({ model, prompt, ms: elapsed, urls, saved }, null, 2));
      return EXIT.OK;
    }
    out('');
    urls.forEach((u) => out(`  ${c.blue(u)}`));
    saved.forEach((s) => out(`  ${c.green('saved')} ${s.file} ${c.gray(`(${Math.round(s.bytes / 1024)} KB)`)}`));
    out(kv('elapsed', `${elapsed} ms`));
    return EXIT.OK;
  } catch (err) {
    if (err.status === 408 && !flags.async) {
      out(c.yellow('Sync generation timed out. Retry the same request with --async.'));
    }
    out(c.red(err.message));
    return exitCodeForError(err);
  }
}
