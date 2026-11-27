#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const bin = path.join(root, 'bin', 'local-terminal-mcp.js');
const cwd = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();

const hasGlab = spawnSync('glab', ['--version'], { stdio: 'ignore' }).status === 0;

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [bin, '--quiet'],
  env: { ...process.env },
  stderr: 'pipe',
});
const client = new Client({ name: 'local-terminal-demo', version: '1.0.0' });
await client.connect(transport);

async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content?.[0]?.text ?? '';
  if (result.isError) throw new Error(text);
  return JSON.parse(text);
}

function preview(text, limit = 160) {
  const clean = (text || '').trim().replace(/\s+/g, ' ').replace(/\u001b\[[0-9;]*m/g, '');
  return clean.length > limit ? `${clean.slice(0, limit)}...` : clean;
}

const results = [];
function record(name, status, detail) {
  results.push({ name, status, detail });
}

async function exec(id, command, options = {}) {
  const result = await call('terminal_exec', { id, command, timeoutMs: 30000, ...options });
  return result;
}

async function checkCommand(id, label, command, expectedExit = 0, options = {}) {
  try {
    const result = await exec(id, command, options);
    const exit = result.exitCode;
    const ok = result.completed && (expectedExit === null || exit === expectedExit);
    record(
      label,
      ok ? 'PASS' : 'FAIL',
      `${result.waitedMs}ms exit=${exit ?? '?'}${result.completed ? '' : ' (incomplete)'} ${preview(result.output)}`,
    );
  } catch (err) {
    record(label, 'FAIL', err.message);
  }
}

const main = await call('terminal_spawn', { name: 'demo-main', cwd });
const second = await call('terminal_spawn', { name: 'demo-second', cwd: '/tmp' });
const mainId = main.session.id;
const secondId = second.session.id;

console.log(`local-terminal-mcp demo`);
console.log(`server: ${path.relative(process.cwd(), bin)}`);
console.log(`working directory: ${cwd}`);
console.log(`sessions: ${mainId} (main), ${secondId} (second)\n`);

await checkCommand(mainId, 'print working directory', 'pwd');
await checkCommand(mainId, 'list directory', 'ls | head -5');
await checkCommand(mainId, 'pipes and sorting', "printf 'banana\\napple\\napple\\n' | sort | uniq -c");
await checkCommand(mainId, 'quotes and unicode', 'echo "unicode: héllo ✓"');
await checkCommand(mainId, 'persistent shell state', 'export DEMO_VAR=hello; cd /tmp; pwd; echo "var=$DEMO_VAR"');
await checkCommand(mainId, 'stderr capture', 'echo "to-stderr" >&2');
await checkCommand(mainId, 'non-zero exit code', 'node -e "process.exit(3)"', 3);
await checkCommand(mainId, 'missing command', 'this-command-does-not-exist', 127);
await checkCommand(mainId, 'slow command waits for completion', 'sleep 1; echo slow-ok');
await checkCommand(mainId, 'silent command', 'true', 0);

if (hasGlab) {
  await checkCommand(mainId, 'gitlab cli version', 'glab --version');
  const auth = await exec(mainId, 'glab auth status');
  record(
    'gitlab cli auth status',
    auth.exitCode === 0 ? 'PASS' : 'SKIP',
    `${auth.waitedMs}ms exit=${auth.exitCode ?? '?'} ${preview(auth.output)}`,
  );
  await checkCommand(mainId, 'gitlab repo list (read-only)', 'glab repo list --per-page 2');
  await checkCommand(mainId, 'gitlab silent config read', 'glab config get editor');
} else {
  record('gitlab cli', 'SKIP', 'glab is not installed');
}

const parallel = await Promise.all([
  exec(mainId, 'for i in 1 2 3; do echo "main-$i"; sleep 0.1; done'),
  exec(secondId, 'for i in 1 2 3; do echo "second-$i"; sleep 0.1; done'),
]);
const isolated =
  parallel[0].completed &&
  parallel[1].completed &&
  /main-1/.test(parallel[0].output) &&
  !/second-/.test(parallel[0].output) &&
  /second-1/.test(parallel[1].output) &&
  !/main-/.test(parallel[1].output);
record(
  'two sessions run in parallel',
  isolated ? 'PASS' : 'FAIL',
  `${parallel[0].waitedMs}ms / ${parallel[1].waitedMs}ms`,
);

try {
  const oneOff = await call('terminal_run', { command: 'node --version', cwd });
  record(
    'one-off terminal_run',
    oneOff.exitCode === 0 ? 'PASS' : 'FAIL',
    `${oneOff.durationMs}ms exit=${oneOff.exitCode} ${preview(oneOff.stdout)}`,
  );
} catch (err) {
  record('one-off terminal_run', 'FAIL', err.message);
}

await call('terminal_close', { id: mainId });
await call('terminal_close', { id: secondId });
await client.close();
await transport.close();

console.log('results:');
for (const item of results) {
  console.log(`  [${item.status.padEnd(4)}] ${item.name.padEnd(36)} ${item.detail}`);
}

const passed = results.filter((item) => item.status === 'PASS').length;
const failed = results.filter((item) => item.status === 'FAIL').length;
const skipped = results.filter((item) => item.status === 'SKIP').length;
console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
process.exit(failed === 0 ? 0 : 1);
