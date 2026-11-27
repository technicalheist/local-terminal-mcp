import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { TerminalManager, runOnce, stripAnsi, resolveCwd } from '../src/terminal.js';

const isWindows = process.platform === 'win32';
const nodeEval = (code) => `"${process.execPath}" -e "${code}"`;

function useManager(t, options = {}) {
  const manager = new TerminalManager(options);
  t.after(async () => {
    await manager.disposeAll();
  });
  return manager;
}

test(
  'spawns a session and keeps shell state between commands',
  { skip: isWindows ? 'POSIX shell syntax' : false },
  async (t) => {
    const manager = useManager(t);
    const session = await manager.spawn({ name: 'state-test' });
    assert.equal(session.status, 'running');
    assert.ok(session.pid > 0);

    const first = session.nextSeq;
    await session.write('cd /tmp && export LTM_TEST=hello');
    await session.waitForIdle({ idleMs: 300, timeoutMs: 5000 });

    const second = session.nextSeq;
    await session.write('printf "%s:%s\\n" "$LTM_TEST" "$PWD"');
    await session.waitForIdle({ idleMs: 300, timeoutMs: 5000 });

    const output = session.read({ since: second }).output.trim();
    assert.equal(output, 'hello:/tmp');
    assert.ok(session.read({ since: first }).nextSince >= second);

    await manager.close(session.id);
    assert.equal(manager.list().length, 0);
  },
);

test('resolves sessions by friendly name', async (t) => {
  const manager = useManager(t);
  const session = await manager.spawn({ name: 'named' });
  assert.equal(manager.resolve('named').id, session.id);
  await manager.close('named');
});

test('reads only new output with a cursor', async (t) => {
  const manager = useManager(t);
  const session = await manager.spawn({});
  await session.write(nodeEval("console.log('first')"));
  await session.waitForIdle({ idleMs: 250, timeoutMs: 8000 });

  const snapshot = session.read({});
  assert.match(snapshot.output, /first/);

  const cursor = snapshot.nextSince;
  await session.write(nodeEval("console.log('second')"));
  await session.waitForIdle({ idleMs: 250, timeoutMs: 8000 });

  const next = session.read({ since: cursor });
  assert.match(next.output, /second/);
  assert.doesNotMatch(next.output, /first/);
});

test('captures stderr from the session', async (t) => {
  const manager = useManager(t);
  const session = await manager.spawn({});
  await session.write(nodeEval("console.error('problem')"));
  await session.waitForIdle({ idleMs: 250, timeoutMs: 8000 });
  assert.match(session.read({}).output, /problem/);
});

test('runOnce returns stdout, stderr and exit code', async () => {
  const result = await runOnce({
    command: nodeEval(
      "process.stdout.write('out');process.stderr.write('err');process.exit(7)",
    ),
  });
  assert.equal(result.stdout, 'out');
  assert.equal(result.stderr, 'err');
  assert.equal(result.exitCode, 7);
  assert.equal(result.timedOut, false);
});

test('runOnce times out long commands', async () => {
  const result = await runOnce({
    command: nodeEval('setTimeout(() => {}, 5000)'),
    timeoutMs: 1000,
  });
  assert.equal(result.timedOut, true);
});

test('read-only mode blocks writes and new sessions', async (t) => {
  const manager = useManager(t, { readOnly: true });
  await assert.rejects(() => manager.spawn({}), /read-only/);
  assert.equal(manager.list().length, 0);
});

test('buffers drop old output when the limit is reached', async (t) => {
  const manager = useManager(t, { bufferSize: 2048 });
  const session = await manager.spawn({});
  await session.write(
    nodeEval("for (let i = 0; i < 400; i += 1) console.log('line-' + i + '-abcdefghij')"),
  );
  await session.waitForIdle({ idleMs: 400, timeoutMs: 15000 });
  const snapshot = session.read({ lines: 5000 });
  assert.ok(snapshot.droppedChars > 0);
  assert.ok(snapshot.output.length <= 2048);
});

test('stripAnsi removes colour codes', () => {
  assert.equal(stripAnsi('\u001b[31mred\u001b[0m'), 'red');
});

test('resolveCwd expands home and rejects missing directories', () => {
  assert.equal(resolveCwd('~'), os.homedir());
  assert.throws(() => resolveCwd('/definitely/not/here'), /does not exist/);
});
