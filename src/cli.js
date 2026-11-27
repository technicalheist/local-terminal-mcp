import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createTerminalServer } from './server.js';
import { defaultShell } from './terminal.js';
import { VERSION } from './version.js';
import { parseArgs, HELP } from './options.js';
import { runProxy } from './proxy.js';

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`local-terminal-mcp: ${err.message}\n\n${HELP}`);
    process.exitCode = 1;
    return;
  }

  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  if (options.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  if (!options.noDaemon && process.env.LOCAL_TERMINAL_NO_DAEMON !== '1') {
    await runProxy(options);
    return;
  }

  const { server, manager } = createTerminalServer(options);
  const transport = new StdioServerTransport();

  let shuttingDown = false;
  const shutdown = async (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await manager.disposeAll();
    } finally {
      process.exit(code);
    }
  };

  process.on('SIGINT', () => void shutdown(0));
  process.on('SIGTERM', () => void shutdown(0));
  process.stdin.on('end', () => void shutdown(0));

  await server.connect(transport);

  if (!options.quiet) {
    process.stderr.write(
      `local-terminal-mcp v${VERSION} ready (shell: ${manager.shell}, max sessions: ${manager.maxSessions})\n`,
    );
  }
}

export { defaultShell, parseArgs, HELP, VERSION };
