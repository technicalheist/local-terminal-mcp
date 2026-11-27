import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { socketPath, statePath, logPath, ensureBaseDir } from './daemon-paths.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function tryConnect(socket, timeoutMs = 400) {
  return new Promise((resolve) => {
    const connection = net.connect(socket);
    const timer = setTimeout(() => {
      connection.destroy();
      resolve(null);
    }, timeoutMs);
    connection.once('connect', () => {
      clearTimeout(timer);
      resolve(connection);
    });
    connection.once('error', () => {
      clearTimeout(timer);
      connection.destroy();
      resolve(null);
    });
  });
}

function daemonArgs(options) {
  const args = [fileURLToPath(new URL('./daemon.js', import.meta.url)), '--quiet'];
  if (options.shell) args.push('--shell', options.shell);
  if (options.cwd) args.push('--cwd', options.cwd);
  if (options.maxSessions !== undefined) args.push('--max-sessions', String(options.maxSessions));
  if (options.bufferSize !== undefined) args.push('--buffer-size', String(options.bufferSize));
  if (options.readOnly) args.push('--read-only');
  return args;
}

function spawnDaemon(options, socket, state, log) {
  ensureBaseDir();
  fs.mkdirSync(path.dirname(log), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(log, 'a', 0o600);
  try {
    const child = spawn(process.execPath, daemonArgs(options), {
      detached: true,
      stdio: ['ignore', fd, fd],
      cwd: process.cwd(),
      env: {
        ...process.env,
        LOCAL_TERMINAL_SOCKET: socket,
        LOCAL_TERMINAL_STATE: state,
        LOCAL_TERMINAL_LOG: log,
      },
      windowsHide: true,
    });
    child.unref();
  } finally {
    fs.closeSync(fd);
  }
}

export async function runProxy(options = {}) {
  const socket = socketPath(options);
  const state = statePath(options);
  const log = logPath();

  let connection = await tryConnect(socket);
  if (!connection) {
    spawnDaemon(options, socket, state, log);
    for (let attempt = 0; attempt < 100 && !connection; attempt += 1) {
      await sleep(100);
      connection = await tryConnect(socket);
    }
  }

  if (!connection) {
    process.stderr.write(
      `local-terminal-mcp: could not start the session daemon (socket: ${socket})\n`,
    );
    process.exit(1);
  }

  process.stdin.pipe(connection);
  connection.pipe(process.stdout);
  process.stdin.on('error', () => {});
  process.stdin.on('end', () => {
    try {
      connection.end();
    } catch {
      /* best effort */
    }
    const timer = setTimeout(() => process.exit(0), 500);
    timer.unref();
  });

  const stop = () => {
    try {
      connection.end();
    } catch {
      /* best effort */
    }
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  connection.on('error', (err) => {
    process.stderr.write(`local-terminal-mcp: ${err.message}\n`);
    process.exit(1);
  });
  connection.on('close', () => process.exit(0));
}
