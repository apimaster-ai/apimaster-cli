import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ApiError, Client } from '../lib/client.js';
import { EXIT, exitCodeForError } from '../lib/exit.js';
import { c, heading, kv } from '../lib/ui.js';

export const help = `
apimaster video — submit a text-to-video or image-to-video job, wait for it, download the MP4.

Usage
  apimaster video "<prompt>" [options]

Options
  --model <id>          seedance-2.5 (default), seedance-2.0, kling-v3-omni, kling-v3-motion-control,
                        MiniMax-H3, grok-imagine-video-1.5
  --duration <seconds>  4 | 8 | 12 | 16 | 20   (default 4)
  --resolution <r>      720p (default); higher tiers depend on the model
  --aspect <ratio>      16:9 | 9:16   (default 16:9)
  --ref <url>           reference image for image-to-video
  --out <dir>           download directory (default ./out)
  --no-download         print the content URL only
  --json                machine-readable output

Notes
  Video jobs are slow: seedance-2.5 took about 15 minutes for 4 seconds. The command
  waits up to 30 minutes, and a job that outlives that is not lost - poll it later.

  For image-to-video always pass --aspect explicitly. A portrait reference image with
  no aspect flag is treated as 16:9 by the gateway.
`;

export async function pollVideo(client, taskId, { onTick, initialDelay = 15000, interval = 4000 } = {}) {
  await delay(initialDelay);
  let failures = 0;
  for (let attempt = 0; attempt < 435; attempt += 1) {
    let res;
    try {
      res = await client.videoStatus(taskId);
      failures = 0;
    } catch (err) {
      // The job keeps running server-side and is already paid for: a dropped connection or a
      // 5xx while polling must not throw it away. A 4xx is a real answer, so it does.
      if (err instanceof ApiError && err.status < 500) throw err;
      failures += 1;
      if (failures >= 5) throw err;
      await delay(interval);
      continue;
    }
    const status = res.data?.status;
    onTick?.(status, attempt);
    if (status === 'completed') return res.data;
    if (['failed', 'error', 'cancelled'].includes(status)) {
      throw new Error(`task ${status}: ${JSON.stringify(res.data).slice(0, 300)}`);
    }
    await delay(interval);
  }
  throw new Error(`gave up polling after ~30 minutes; the job is not lost, check it later: GET /v1/videos/${taskId}`);
}

export async function run({ config, flags, positionals, out }) {
  const prompt = positionals.join(' ').trim() || flags.prompt;
  if (!prompt) {
    out(c.red('Usage: apimaster video "a waterfall forming a rainbow, cinematic" --duration 4'));
    return EXIT.USAGE;
  }

  const model = flags.model || 'seedance-2.5';
  const body = {
    model,
    prompt,
    duration: Number(flags.duration ?? 4),
    resolution: flags.resolution || '720p',
    aspect_ratio: flags.aspect || '16:9',
  };
  if (flags.ref) body.image_urls = [].concat(flags.ref);

  const client = new Client({ ...config, debug: flags.debug });
  const started = performance.now();

  if (!flags.json) {
    out(heading(`video ${c.cyan(model)}`));
    out(kv('prompt', c.gray(prompt.slice(0, 70))));
    out(kv('duration', `${body.duration}s`));
    out(kv('resolution', body.resolution));
    out(kv('aspect', body.aspect_ratio));
    out('');
  }

  try {
    const submit = await client.videoSubmit(body, { timeout: 60000 });
    // The native endpoint answers with data[].task_id; the OpenAI-compatible one with id.
    const taskId = submit.data?.data?.[0]?.task_id ?? submit.data?.id;
    if (!taskId) throw new Error(`no task id in response: ${JSON.stringify(submit.data).slice(0, 200)}`);
    if (!flags.json) out(`  ${c.gray('task')} ${taskId}`);

    const done = await pollVideo(client, taskId, {
      onTick: (status, i) => {
        if (!flags.json && i % 5 === 0) out(c.gray(`  … ${status ?? 'queued'}`));
      },
    });

    const contentUrl = done.url || client.videoContentUrl(taskId);
    let saved = null;
    if (!flags['no-download']) {
      const dir = flags.out || 'out';
      fs.mkdirSync(dir, { recursive: true });
      const res = await fetch(contentUrl, {
        headers: { Authorization: `Bearer ${config.key}` },
        redirect: 'follow',
      });
      if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const file = path.join(dir, `${model}-${taskId}.mp4`);
      fs.writeFileSync(file, buf);
      saved = { file, bytes: buf.length };
    }

    const elapsed = Math.round(performance.now() - started);
    if (flags.json) {
      out(JSON.stringify({ model, prompt, task_id: taskId, ms: elapsed, url: contentUrl, saved }, null, 2));
      return EXIT.OK;
    }
    out('');
    out(`  ${c.blue(contentUrl)}`);
    if (saved) out(`  ${c.green('saved')} ${saved.file} ${c.gray(`(${Math.round(saved.bytes / 1024 / 1024)} MB)`)}`);
    out(kv('elapsed', `${elapsed} ms`));
    return EXIT.OK;
  } catch (err) {
    out(c.red(err.message));
    return exitCodeForError(err);
  }
}
