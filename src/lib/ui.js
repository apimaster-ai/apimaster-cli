const useColor =
  process.env.NO_COLOR === undefined &&
  process.env.TERM !== 'dumb' &&
  (process.stdout.isTTY || process.env.FORCE_COLOR);

const wrap = (open, close) => (s) => (useColor ? `\u001b[${open}m${s}\u001b[${close}m` : String(s));

export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
};

export const sym = {
  ok: c.green('✔'),
  fail: c.red('✘'),
  warn: c.yellow('!'),
  info: c.blue('·'),
};

/** Visible width, counting CJK wide chars as 2 and ignoring ANSI escapes. */
export function width(str) {
  const plain = String(str).replace(/\u001b\[[0-9;]*m/g, '');
  let w = 0;
  for (const ch of plain) {
    const cp = ch.codePointAt(0);
    w +=
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6)
        ? 2
        : 1;
  }
  return w;
}

function pad(str, len, align = 'left') {
  const fill = ' '.repeat(Math.max(0, len - width(str)));
  return align === 'right' ? fill + str : str + fill;
}

/**
 * Render a plain-text table. `columns` is [{ key, label, align }].
 */
export function table(rows, columns) {
  if (!rows.length) return c.gray('(empty)');
  const widths = columns.map((col) =>
    Math.max(width(col.label), ...rows.map((r) => width(r[col.key] ?? '')))
  );
  const line = (cells) =>
    cells.map((cell, i) => pad(cell, widths[i], columns[i].align)).join('  ');
  const head = line(columns.map((col) => c.bold(col.label)));
  const rule = c.gray(line(widths.map((w) => '─'.repeat(w))));
  const body = rows.map((r) => line(columns.map((col) => String(r[col.key] ?? ''))));
  return [head, rule, ...body].join('\n');
}

export function heading(text) {
  return `\n${c.bold(text)}`;
}

export function kv(key, value) {
  return `  ${c.gray(pad(key + ':', 18))} ${value}`;
}

export function ms(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return c.gray('—');
  const v = Math.round(n);
  const s = `${v} ms`;
  if (v < 800) return c.green(s);
  if (v < 2500) return c.yellow(s);
  return c.red(s);
}

export function bar(value, max, size = 18) {
  if (!max) return '';
  const filled = Math.max(1, Math.round((value / max) * size));
  return c.gray('█'.repeat(filled) + '░'.repeat(Math.max(0, size - filled)));
}
