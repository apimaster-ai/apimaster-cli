#!/usr/bin/env node
import { main } from '../src/cli.js';

main(process.argv.slice(2)).catch((err) => {
  if (err && err.__handled) {
    process.exit(err.exitCode ?? 1);
  }
  console.error(err?.stack || String(err));
  process.exit(1);
});
