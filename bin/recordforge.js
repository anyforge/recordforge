#!/usr/bin/env node
import { main } from '../src/cli.js';

main(process.argv.slice(2)).catch((e) => {
  console.error('recordforge: ' + (e && e.message ? e.message : e));
  process.exit(1);
});
