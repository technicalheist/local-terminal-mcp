import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TerminalManager } from './terminal.js';
import { createTerminalServer } from './server.js';
import { SocketServerTransport } from './socket-transport.js';
import { parseArgs } from './options.js';
import { socketPath, statePath, logPath } from './daemon-paths.js';
import { VERSION } from './version.js';

function logLine(message) {
  const file = logPath();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    if (stat && stat.size > 256 * 1024) {
      fs.renameSync(file, `${file}.1`);
    }
  } catch {
    /* best effort */
  }
  try {
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${message}\n`, { mode: 0o600 });
  } catch {
    /* best effort */
  }
}

function canConnect(socket, timeoutMs = 300) {
  return new Promise((resolve) => {
    const client = net.connect(socket);
    const timer = setTimeout(() => {
      client.destroy();
      resolve(false);
    }, timeoutMs);
    client.once('connect', () => {
      clearTimeout(timer);
      client.destroy();
      resolve(true);
    });
    client.once('error', () => {
      clearTimeout(timer);
      client.destroy();
      resolve(false);
    });
  });
}

export async function runDaemon(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const socket = socketPath(options);
  const state = statePath(options);

  if (process.platform !== 'win32') {
    fs.mkdirSync(path.dirname(socket), { recursive: true, mode: 0o700 });
  }
  fs.mkdirSync(path.dirname(state), { recursive: true, mode: 0o700 });

  if (process.platform !== 'win32' && fs.existsSync(socket)) {
    if (await canConnect(socket)) {
      logLine(`daemon already running at ${socket}`);
      return;
    }
    fs.rmSync(socket, { force: true });
  }

  const manager = new TerminalManager({
    shell: options.shell,
    cwd: options.cwd,
    maxSessions: options.maxSessions,
    bufferSize: options.bufferSize,
    readOnly: options.readOnly,
  });

  const server = net.createServer((connection) => {
    connection.setEncoding('utf8');
    connection.on('error', (err) => {
      logLine(`connection error: ${err.message}`);
    });

    const { server: mcp } = createTerminalServer({ manager });
    const transport = new SocketServerTransport(connection);
    mcp.connect(transport).catch((err) => {
      logLine(`mcp connect error: ${err?.stack || err}`);
    });
    connection.on('close', () => {
      transport.close().catch(() => {});
    });
  });

  server.on('error', (err) => {
    logLine(`server error: ${err?.stack || err}`);
  });

  await new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(socket);
  });

  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(socket, 0o600);
    } catch {
      /* best effort */
    }
  }

  try {
    fs.writeFileSync(
      state,
      JSON.stringify(
        {
          pid: process.pid,
          version: VERSION,
          socket,
          startedAt: new Date().toISOString(),
          options: {
            shell: options.shell ?? null,
            cwd: options.cwd ?? null,
            maxSessions: options.maxSessions ?? 32,
            bufferSize: options.bufferSize ?? 1024 * 1024,
            readOnly: Boolean(options.readOnly),
          },
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  } catch (err) {
    logLine(`state write error: ${err.message}`);
  }

  logLine(`started pid=${process.pid} socket=${socket}`);

  let shuttingDown = false;
  const shutdown = async (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logLine(`shutting down pid=${process.pid}`);
    try {
      await manager.disposeAll();
    } catch (err) {
      logLine(`dispose error: ${err?.stack || err}`);
    }
    try {
      server.close();
    } catch {
      /* best effort */
    }
    try {
      if (process.platform !== 'win32') fs.rmSync(socket, { force: true });
      fs.rmSync(state, { force: true });
    } catch {
      /* best effort */
    }
    process.exit(code);
  };

  process.on('SIGINT', () => void shutdown(0));
  process.on('SIGTERM', () => void shutdown(0));
  process.on('SIGHUP', () => {});
  process.on('uncaughtException', (err) => {
    logLine(`uncaughtException: ${err?.stack || err}`);
  });
  process.on('unhandledRejection', (err) => {
    logLine(`unhandledRejection: ${err?.stack || err}`);
  });

  return { manager, server, socket };
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  runDaemon().catch((err) => {
    logLine(`fatal: ${err?.stack || err}`);
    process.exit(1);
  });
}
