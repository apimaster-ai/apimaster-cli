import fs from 'node:fs';
import path from 'node:path';
import { TARGETS, listTargets } from '../lib/targets.js';
import { EXIT } from '../lib/exit.js';
import { c, heading, table } from '../lib/ui.js';

export const help = `
apimaster use — print (or write) the config that points a tool at this endpoint.

Usage
  apimaster use                      list every supported tool
  apimaster use <tool>               print the config
  apimaster use <tool> --write       write it to disk, backing up any existing file
  apimaster use <tool> --json        emit the config as JSON

Examples
  apimaster use claude-code --write
  apimaster use codex
  apimaster use open-webui
`;

function deepMerge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(base?.[k] ?? {}, v) : v;
  }
  return out;
}

function writeFileWithBackup(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    const backup = `${file}.bak-${Date.now()}`;
    fs.copyFileSync(file, backup);
    fs.writeFileSync(file, content, { mode: 0o600 });
    return backup;
  }
  fs.writeFileSync(file, content, { mode: 0o600 });
  return null;
}

export async function run({ config, flags, positionals, out }) {
  const id = positionals[0];

  if (!id) {
    out(heading('Tools this CLI can configure'));
    out('');
    out(
      table(
        listTargets().map((t) => ({ id: c.cyan(t.id), name: t.name, kind: c.gray(t.kind) })),
        [
          { key: 'id', label: 'TOOL' },
          { key: 'name', label: 'NAME' },
          { key: 'kind', label: 'HOW' },
        ]
      )
    );
    out('');
    out(c.gray('  apimaster use claude-code --write'));
    return EXIT.OK;
  }

  const target = TARGETS[id];
  if (!target) {
    out(c.red(`Unknown tool "${id}". Run \`apimaster use\` to see the list.`));
    return EXIT.USAGE;
  }
  if (!config.key) {
    out(c.yellow('No API key resolved — the printed config will have an empty key.'));
  }

  const rendered = target.render ? target.render(config) : null;

  if (flags.json) {
    out(
      JSON.stringify(
        { tool: id, name: target.name, kind: target.kind, file: target.file?.() ?? null, config: rendered, steps: target.steps?.(config) ?? null },
        null,
        2
      )
    );
    return EXIT.OK;
  }

  out(heading(`${target.name}  ${c.gray(`(${target.kind})`)}`));
  if (target.note) out(`  ${c.yellow('note')} ${target.note}`);
  if (target.docs) out(`  ${c.gray('docs')} ${target.docs}`);
  out('');

  if (target.kind === 'ui') {
    target.steps(config).forEach((step, i) => out(`  ${c.gray(`${i + 1}.`)} ${step}`));
    return EXIT.OK;
  }

  if (target.kind === 'env') {
    const lines = Object.entries(rendered).map(([k, v]) => `export ${k}="${v}"`);
    lines.forEach((l) => out(`  ${l}`));
    out('');
    out(c.gray('  PowerShell:'));
    Object.entries(rendered).forEach(([k, v]) => out(`  ${c.gray(`$env:${k} = "${v}"`)}`));
    return EXIT.OK;
  }

  if (target.kind === 'snippet') {
    out(rendered.split('\n').map((l) => `  ${l}`).join('\n'));
    return EXIT.OK;
  }

  // file targets
  const file = target.file();
  let content;
  if (target.format === 'json-merge') {
    let existing = {};
    try {
      existing = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      /* no existing config */
    }
    content = JSON.stringify(deepMerge(existing, rendered), null, 2) + '\n';
  } else {
    content = rendered;
  }

  if (flags.write) {
    const backup = writeFileWithBackup(file, content);
    out(`  ${c.green('wrote')} ${file}`);
    if (backup) out(`  ${c.gray('backup')} ${backup}`);
    if (target.verify) out(`  ${c.gray('verify with')} ${target.verify}`);
    return EXIT.OK;
  }

  out(c.gray(`  → ${file}`));
  out('');
  out(content.split('\n').map((l) => `  ${l}`).join('\n'));
  out(c.gray(`  Run with --write to save it (an existing file is backed up first).`));
  if (target.verify) out(c.gray(`  Then verify: ${target.verify}`));
  return EXIT.OK;
}
