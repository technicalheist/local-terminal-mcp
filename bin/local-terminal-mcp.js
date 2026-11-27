#!/usr/bin/env node
import { main } from '../src/cli.js';

main().catch((err) => {
  process.stderr.write(`local-terminal-mcp: ${err?.stack || err}\n`);
  process.exit(1);
});
