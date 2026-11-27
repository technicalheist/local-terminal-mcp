import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const bin = fileURLToPath(new URL('../bin/local-terminal-mcp.js', import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parse(result) {
  assert.ok(Array.isArray(result.content), 'expected content array');
  const text = result.content.find((item) => item.type === 'text');
  assert.ok(text, 'expected text content');
  return JSON.parse(text.text);
}

async function connect(env) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bin, '--quiet'],
    env,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'local-terminal-daemon-test', version: '1.0.0' });
  await client.connect(transport);
  return { client, transport };
}

test(
  'sessions survive an MCP server restart through the daemon',
  { skip: process.platform === 'win32' ? 'daemon test uses a unix socket' : false, timeout: 60000 },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ltm-daemon-'));
    const socket = path.join(dir, 'daemon.sock');
    const state = path.join(dir, 'daemon.json');
    const log = path.join(dir, 'daemon.log');
    const env = {
      ...process.env,
      LOCAL_TERMINAL_SOCKET: socket,
      LOCAL_TERMINAL_STATE: state,
      LOCAL_TERMINAL_LOG: log,
    };
    let daemonPid = null;

    try {
      const first = await connect(env);
      const spawned = parse(
        await first.client.callTool({
          name: 'terminal_spawn',
          arguments: { name: 'persist', cwd: dir },
        }),
      );
      const id = spawned.session.id;

      const executed = parse(
        await first.client.callTool({
          name: 'terminal_exec',
          arguments: { id, command: `"${process.execPath}" -e "console.log('persisted')"` },
        }),
      );
      assert.equal(executed.completed, true);
      assert.match(executed.output, /persisted/);

      await first.client.close();
      await first.transport.close();
      await sleep(300);

      const second = await connect(env);
      try {
        const listed = parse(await second.client.callTool({ name: 'terminal_list', arguments: {} }));
        assert.equal(listed.count, 1);
        assert.equal(listed.sessions[0].id, id);
        assert.equal(listed.sessions[0].status, 'running');

        const read = parse(
          await second.client.callTool({ name: 'terminal_read', arguments: { id } }),
        );
        assert.match(read.output, /persisted/);

        const still = parse(
          await second.client.callTool({
            name: 'terminal_exec',
            arguments: { id, command: `"${process.execPath}" -e "console.log('still-alive')"` },
          }),
        );
        assert.equal(still.completed, true);
        assert.match(still.output, /still-alive/);

        await second.client.callTool({ name: 'terminal_close', arguments: { id } });
      } finally {
        await second.client.close();
        await second.transport.close();
      }

      const info = JSON.parse(fs.readFileSync(state, 'utf8'));
      daemonPid = info.pid;
      assert.ok(Number.isInteger(daemonPid) && daemonPid > 0);
    } finally {
      if (daemonPid) {
        try {
          process.kill(daemonPid, 'SIGTERM');
        } catch {
          /* already gone */
        }
        for (let i = 0; i < 60 && fs.existsSync(state); i += 1) await sleep(50);
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);
