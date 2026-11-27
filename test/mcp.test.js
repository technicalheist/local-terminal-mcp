import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const bin = fileURLToPath(new URL('../bin/local-terminal-mcp.js', import.meta.url));

function parse(result) {
  assert.ok(Array.isArray(result.content), 'expected content array');
  const text = result.content.find((item) => item.type === 'text');
  assert.ok(text, 'expected text content');
  return JSON.parse(text.text);
}

async function connect() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bin, '--quiet', '--no-daemon'],
    env: { ...process.env },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'local-terminal-mcp-test', version: '1.0.0' });
  await client.connect(transport);
  return { client, transport };
}

test('MCP server exposes the terminal tools and runs commands end to end', async () => {
  const { client, transport } = await connect();

  try {
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [
      'terminal_close',
      'terminal_exec',
      'terminal_list',
      'terminal_read',
      'terminal_run',
      'terminal_signal',
      'terminal_spawn',
      'terminal_write',
    ]);

    const spawned = parse(
      await client.callTool({ name: 'terminal_spawn', arguments: { name: 'mcp-test' } }),
    );
    const id = spawned.session.id;
    assert.match(id, /^term_/);

    const executed = parse(
      await client.callTool({
        name: 'terminal_exec',
        arguments: { id, command: `"${process.execPath}" -e "console.log('mcp-ok')"` },
      }),
    );
    assert.match(executed.output, /mcp-ok/);
    assert.equal(executed.completed, true);
    assert.equal(executed.exitCode, 0);

    const listed = parse(await client.callTool({ name: 'terminal_list', arguments: {} }));
    assert.equal(listed.count, 1);
    assert.equal(listed.sessions[0].name, 'mcp-test');

    const oneOff = parse(
      await client.callTool({
        name: 'terminal_run',
        arguments: { command: `"${process.execPath}" -e "process.stdout.write('done')"` },
      }),
    );
    assert.equal(oneOff.stdout, 'done');
    assert.equal(oneOff.exitCode, 0);

    const closed = parse(
      await client.callTool({ name: 'terminal_close', arguments: { id } }),
    );
    assert.equal(closed.closed, true);
    assert.equal(closed.remaining, 0);

    const bad = await client.callTool({
      name: 'terminal_read',
      arguments: { id: 'term_missing' },
    });
    assert.equal(bad.isError, true);
  } finally {
    await client.close();
    await transport.close();
  }
});
