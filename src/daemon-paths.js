import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VERSION } from './version.js';

export function baseDir() {
  return path.join(os.homedir(), '.local-terminal-mcp');
}

function normalized(options = {}) {
  return {
    shell: options.shell || '',
    cwd: options.cwd || '',
    maxSessions: options.maxSessions ?? 32,
    bufferSize: options.bufferSize ?? 1024 * 1024,
    readOnly: Boolean(options.readOnly),
  };
}

function optionsHash(options = {}) {
  return crypto
    .createHash('sha1')
    .update(JSON.stringify(normalized(options)))
    .digest('hex')
    .slice(0, 8);
}

export function socketPath(options = {}) {
  if (process.env.LOCAL_TERMINAL_SOCKET) return process.env.LOCAL_TERMINAL_SOCKET;
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\local-terminal-mcp-${VERSION}-${optionsHash(options)}`;
  }
  return path.join(baseDir(), `daemon-${VERSION}-${optionsHash(options)}.sock`);
}

export function statePath(options = {}) {
  if (process.env.LOCAL_TERMINAL_STATE) return process.env.LOCAL_TERMINAL_STATE;
  if (process.platform === 'win32') {
    return path.join(baseDir(), `daemon-${VERSION}-${optionsHash(options)}.json`);
  }
  return `${socketPath(options)}.json`;
}

export function logPath() {
  if (process.env.LOCAL_TERMINAL_LOG) return process.env.LOCAL_TERMINAL_LOG;
  return path.join(baseDir(), 'daemon.log');
}

export function ensureBaseDir() {
  const dir = baseDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      /* best effort */
    }
  }
  return dir;
}
