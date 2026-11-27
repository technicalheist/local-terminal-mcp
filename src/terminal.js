import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const isWindows = process.platform === 'win32';

const ANSI_PATTERN = new RegExp(
  [
    '[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]+)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?\\u0007)',
    '(?:(?:\\d{1,4}(?:[;:]\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))',
  ].join('|'),
  'g',
);

const OSC_PATTERN = /\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function stripAnsi(text) {
  return text.replace(OSC_PATTERN, '').replace(ANSI_PATTERN, '');
}

export function defaultShell() {
  if (isWindows) {
    return process.env.COMSPEC || 'cmd.exe';
  }
  if (process.env.SHELL && fs.existsSync(process.env.SHELL)) {
    return process.env.SHELL;
  }
  if (fs.existsSync('/bin/zsh')) return '/bin/zsh';
  if (fs.existsSync('/bin/bash')) return '/bin/bash';
  return '/bin/sh';
}

export function resolveCwd(input, fallback) {
  const base = fallback || process.cwd();
  if (!input) return base;

  let candidate = String(input);
  if (candidate === '~') {
    candidate = os.homedir();
  } else if (candidate.startsWith('~/') || candidate.startsWith('~\\')) {
    candidate = path.join(os.homedir(), candidate.slice(2));
  }

  const resolved = path.resolve(base, candidate);
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new Error(`Directory does not exist: ${resolved}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Not a directory: ${resolved}`);
  }
  return resolved;
}

function shellArgs(shell) {
  if (!isWindows) return [];
  const name = path.basename(shell).toLowerCase();
  if (name.startsWith('powershell') || name === 'pwsh.exe' || name === 'pwsh') {
    return ['-NoLogo', '-NoProfile', '-Command', '-'];
  }
  if (name === 'cmd.exe' || name === 'cmd') {
    return ['/d', '/q'];
  }
  return [];
}

function shellFamily(shell) {
  if (!isWindows) return 'posix';
  const name = path.basename(shell).toLowerCase();
  if (name.startsWith('powershell') || name === 'pwsh.exe' || name === 'pwsh') {
    return 'powershell';
  }
  return 'cmd';
}

class TerminalSession {
  constructor(manager, options) {
    this.manager = manager;
    this.id = `term_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
    this.name = options.name || this.id;
    this.shell = options.shell;
    this.shellFamily = shellFamily(this.shell);
    this.cwd = options.cwd;
    this.createdAt = Date.now();
    this.status = 'starting';
    this.exitCode = null;
    this.signal = null;
    this.error = null;
    this.chunks = [];
    this.bufferedChars = 0;
    this.droppedChars = 0;
    this.nextSeq = 1;
    this.lastOutputAt = Date.now();
    this.lastCommandAt = null;

    const env = { ...process.env, ...(manager.env || {}), ...(options.env || {}) };
    const child = spawn(this.shell, shellArgs(this.shell), {
      cwd: this.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: !isWindows,
      windowsHide: true,
    });

    this.child = child;
    this.pid = child.pid ?? null;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.append('stdout', chunk));
    child.stderr.on('data', (chunk) => this.append('stderr', chunk));

    child.on('error', (err) => {
      this.error = err.message;
      this.status = 'failed';
      this.lastOutputAt = Date.now();
    });

    child.on('exit', (code, signal) => {
      this.status = 'exited';
      this.exitCode = code;
      this.signal = signal;
      this.lastOutputAt = Date.now();
    });

    child.stdin.on('error', () => {});
  }

  async ready() {
    if (this.status !== 'starting') return;
    await new Promise((resolve, reject) => {
      const onSpawn = () => {
        cleanup();
        this.status = 'running';
        resolve();
      };
      const onError = (err) => {
        cleanup();
        reject(new Error(`Failed to start shell "${this.shell}": ${err.message}`));
      };
      const cleanup = () => {
        this.child.off('spawn', onSpawn);
        this.child.off('error', onError);
      };
      this.child.once('spawn', onSpawn);
      this.child.once('error', onError);
    });
  }

  append(stream, text) {
    if (!text) return;
    const seq = this.nextSeq++;
    this.chunks.push({ seq, stream, text });
    this.bufferedChars += text.length;
    this.lastOutputAt = Date.now();

    while (this.bufferedChars > this.manager.bufferSize && this.chunks.length > 1) {
      const removed = this.chunks.shift();
      this.bufferedChars -= removed.text.length;
      this.droppedChars += removed.text.length;
    }

    if (this.bufferedChars > this.manager.bufferSize && this.chunks.length === 1) {
      const only = this.chunks[0];
      const overflow = this.bufferedChars - this.manager.bufferSize;
      only.text = only.text.slice(overflow);
      this.bufferedChars -= overflow;
      this.droppedChars += overflow;
    }
  }

  ensureRunning() {
    if (this.status === 'starting') {
      throw new Error(`Session ${this.id} is still starting.`);
    }
    if (this.status !== 'running') {
      throw new Error(
        `Session ${this.id} is not running (status: ${this.status}${
          this.exitCode !== null ? `, exit code: ${this.exitCode}` : ''
        }).`,
      );
    }
  }

  write(input, { newline = true } = {}) {
    this.ensureRunning();
    let payload = String(input);
    if (newline && !payload.endsWith('\n')) payload += '\n';
    this.lastCommandAt = Date.now();
    return new Promise((resolve, reject) => {
      this.child.stdin.write(payload, 'utf8', (err) => {
        if (err) reject(new Error(`Failed to write to session ${this.id}: ${err.message}`));
        else resolve();
      });
    });
  }

  read({ since, lines = 200, stripAnsi: clean = true, raw = false } = {}) {
    let selected = this.chunks;
    if (since !== undefined && since !== null) {
      selected = selected.filter((chunk) => chunk.seq >= since);
    }

    let output = selected.map((chunk) => chunk.text).join('');

    if (!raw) {
      output = output.replace(/\r\n/g, '\n').replace(/\r/g, '');
    }
    if (clean && !raw) {
      output = stripAnsi(output);
    }

    if (!since && lines && lines > 0) {
      const parts = output.split('\n');
      if (output.endsWith('\n')) parts.pop();
      output = parts.slice(-lines).join('\n');
    }

    return {
      output,
      nextSince: this.nextSeq,
      firstAvailableSeq: this.chunks[0]?.seq ?? this.nextSeq,
      droppedChars: this.droppedChars,
    };
  }

  async waitForIdle({ idleMs = 300, timeoutMs = 15000, since, graceMs = 900 } = {}) {
    const start = Date.now();
    const from = since ?? this.nextSeq;
    let sawOutput = false;

    while (Date.now() - start < timeoutMs) {
      if (this.status === 'exited' || this.status === 'failed') {
        return { settled: true, reason: 'exited', waitedMs: Date.now() - start };
      }

      if (this.nextSeq > from) sawOutput = true;

      const quietFor = Date.now() - this.lastOutputAt;
      if (sawOutput && quietFor >= idleMs) {
        return { settled: true, reason: 'idle', waitedMs: Date.now() - start };
      }
      if (!sawOutput && Date.now() - start >= graceMs) {
        return { settled: false, reason: 'no-output', waitedMs: Date.now() - start };
      }
      await sleep(40);
    }
    return { settled: false, reason: 'timeout', waitedMs: Date.now() - start };
  }

  markerLine(marker) {
    if (this.shellFamily === 'powershell') {
      return (
        `$__ltmOk = $?; ` +
        `$__ltmCode = if ($__ltmOk) { 0 } elseif ($null -ne $LASTEXITCODE) { $LASTEXITCODE } else { 1 }; ` +
        `Write-Output ''; Write-Output "${marker}$__ltmCode"`
      );
    }
    if (this.shellFamily === 'cmd') {
      return `set ${marker}=%errorlevel%\necho.\necho ${marker}%${marker}%`;
    }
    return `printf '\\n${marker}%s\\n' "$?"`;
  }

  stripMarkerFromBuffer(stripPattern) {
    for (const chunk of this.chunks) {
      if (!stripPattern.test(chunk.text)) continue;
      const before = chunk.text.length;
      chunk.text = chunk.text.replace(stripPattern, '');
      this.bufferedChars -= before - chunk.text.length;
      if (this.bufferedChars < 0) this.bufferedChars = 0;
      break;
    }
  }

  async execCommand(command, options = {}) {
    const idleMs = options.idleMs ?? 400;
    const timeoutMs = options.timeoutMs ?? 15000;
    const waitForCompletion = options.waitForCompletion !== false;
    const noOutputGraceMs = options.noOutputGraceMs ?? 5000;

    const cursor = this.nextSeq;
    const token = randomUUID().replace(/-/g, '').slice(0, 10);
    const marker = `__LTM_DONE_${token}__`;
    const markerPattern = new RegExp(`${marker}(\\d+)`);
    const stripPattern = new RegExp(`\\r?\\n?${marker}\\d+\\r?\\n?`);

    let payload = String(command);
    if (!payload.endsWith('\n')) payload += '\n';
    if (waitForCompletion) payload += `${this.markerLine(marker)}\n`;

    await this.write(payload, { newline: false });

    const started = Date.now();
    const deadline = started + timeoutMs;
    let completed = false;
    let exitCode = null;
    let scannedSeq = cursor;
    let pending = '';

    if (waitForCompletion) {
      while (Date.now() < deadline) {
        for (const chunk of this.chunks) {
          if (chunk.seq < scannedSeq) continue;
          scannedSeq = chunk.seq + 1;
          pending += chunk.text;
        }

        const match = pending.match(markerPattern);
        if (match) {
          exitCode = Number(match[1]);
          completed = true;
          break;
        }
        if (pending.length > 8192) pending = pending.slice(-256);

        if (this.status !== 'running') break;

        const quietFor = Date.now() - this.lastOutputAt;
        const sawOutput = this.nextSeq > cursor;
        if (sawOutput && quietFor >= Math.max(idleMs, 1500)) break;
        if (!sawOutput && Date.now() - started >= noOutputGraceMs) break;

        await sleep(40);
      }
    } else {
      await this.waitForIdle({ idleMs, timeoutMs, since: cursor });
    }

    const read = this.read({ since: cursor, raw: options.raw });
    if (completed) this.stripMarkerFromBuffer(stripPattern);
    const output = waitForCompletion ? read.output.replace(stripPattern, '') : read.output;

    return {
      output,
      nextSince: read.nextSince,
      completed,
      exitCode,
      sessionStatus: this.status,
      sessionExitCode: this.exitCode,
      waitedMs: Date.now() - started,
    };
  }

  snapshot() {
    return {
      id: this.id,
      name: this.name,
      shell: this.shell,
      initialCwd: this.cwd,
      pid: this.pid,
      status: this.status,
      exitCode: this.exitCode,
      signal: this.signal,
      error: this.error,
      createdAt: new Date(this.createdAt).toISOString(),
      idleMs: Date.now() - this.lastOutputAt,
      bufferedChars: this.bufferedChars,
      droppedChars: this.droppedChars,
    };
  }
}

export class TerminalManager {
  constructor(options = {}) {
    this.sessions = new Map();
    this.maxSessions = options.maxSessions ?? 32;
    this.bufferSize = options.bufferSize ?? 1024 * 1024;
    this.shell = options.shell || defaultShell();
    this.cwd = options.cwd || process.cwd();
    this.env = options.env || {};
    this.readOnly = Boolean(options.readOnly);
    this.closed = false;
  }

  ensureWritable() {
    if (this.readOnly) {
      throw new Error('This terminal server is running in read-only mode.');
    }
  }

  async spawn(options = {}) {
    this.ensureWritable();
    if (this.closed) throw new Error('Terminal manager is shutting down.');

    const active = [...this.sessions.values()].filter(
      (session) => session.status === 'running' || session.status === 'starting',
    );
    if (active.length >= this.maxSessions) {
      throw new Error(
        `Maximum number of sessions reached (${this.maxSessions}). Close a session first.`,
      );
    }

    if (options.name) {
      for (const existing of this.sessions.values()) {
        if (existing.name === options.name) {
          throw new Error(`A session named "${options.name}" already exists. Pick another name.`);
        }
      }
    }

    const session = new TerminalSession(this, {
      name: options.name,
      shell: options.shell || this.shell,
      cwd: resolveCwd(options.cwd, this.cwd),
      env: options.env,
    });

    try {
      await session.ready();
    } catch (err) {
      this.sessions.delete(session.id);
      throw err;
    }

    this.sessions.set(session.id, session);
    return session;
  }

  resolve(idOrName) {
    if (!idOrName) throw new Error('A session id or name is required.');
    const key = String(idOrName);
    const direct = this.sessions.get(key);
    if (direct) return direct;
    for (const session of this.sessions.values()) {
      if (session.name === key) return session;
    }
    throw new Error(`Unknown session: ${key}. Use terminal_list to see open sessions.`);
  }

  list() {
    return [...this.sessions.values()].map((session) => session.snapshot());
  }

  signal(id, signal = 'SIGINT') {
    this.ensureWritable();
    const session = this.resolve(id);
    if (!session.pid || session.status !== 'running') {
      throw new Error(`Session ${session.id} is not running.`);
    }
    this.killProcess(session, signal);
    return session.snapshot();
  }

  killProcess(session, signal) {
    const pid = session.pid;
    if (!pid) return;
    if (isWindows) {
      const killer = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.on('error', () => {});
      return;
    }
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        process.kill(pid, signal);
      } catch {
        try {
          session.child.kill(signal);
        } catch {
          /* already gone */
        }
      }
    }
  }

  async close(id) {
    const session = this.resolve(id);
    if (session.status === 'running' || session.status === 'starting') {
      this.killProcess(session, 'SIGTERM');

      const exited = await Promise.race([
        new Promise((resolve) => {
          if (session.status !== 'running' && session.status !== 'starting') return resolve(true);
          session.child.once('exit', () => resolve(true));
        }),
        sleep(1500).then(() => false),
      ]);

      if (!exited && session.pid) {
        this.killProcess(session, 'SIGKILL');
        await Promise.race([
          new Promise((resolve) => session.child.once('exit', resolve)),
          sleep(1000),
        ]);
      }
    }
    this.sessions.delete(session.id);
    return session.snapshot();
  }

  async disposeAll() {
    this.closed = true;
    const ids = [...this.sessions.keys()];
    await Promise.allSettled(ids.map((id) => this.close(id)));
  }
}

function killTree(child) {
  if (!child.pid) return;
  if (isWindows) {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.on('error', () => {});
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

function spawnOneShot(shell, command, options) {
  if (isWindows) {
    const name = path.basename(shell).toLowerCase();
    if (name.startsWith('powershell') || name.startsWith('pwsh')) {
      const encoded = Buffer.from(command, 'utf16le').toString('base64');
      return spawn(shell, ['-NoLogo', '-NoProfile', '-EncodedCommand', encoded], options);
    }
    return spawn(command, { ...options, shell });
  }
  return spawn(command, { ...options, shell });
}

export function runOnce(options = {}) {
  const shell = options.shell || defaultShell();
  const command = options.command;
  if (!command) throw new Error('A command is required.');

  const cwd = resolveCwd(options.cwd);
  const timeoutMs = options.timeoutMs ?? 30000;
  const maxOutputChars = options.maxOutputChars ?? 200000;
  const env = { ...process.env, ...(options.env || {}) };

  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawnOneShot(shell, command, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: !isWindows,
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let settled = false;

    const finish = (code, signal, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout: stdout.replace(/\r\n/g, '\n'),
        stderr: stderr.replace(/\r\n/g, '\n'),
        exitCode: code,
        signal: signal ?? null,
        timedOut,
        truncated: stdoutTruncated || stderrTruncated,
        error: error ?? null,
        durationMs: Date.now() - started,
        shell,
        cwd,
      });
    };

    const collect = (target) => (chunk) => {
      const text = chunk.toString('utf8');
      if (target === 'stdout') {
        if (stdout.length >= maxOutputChars) {
          stdoutTruncated = true;
          return;
        }
        stdout += text;
        if (stdout.length > maxOutputChars) {
          stdout = stdout.slice(0, maxOutputChars);
          stdoutTruncated = true;
        }
      } else {
        if (stderr.length >= maxOutputChars) {
          stderrTruncated = true;
          return;
        }
        stderr += text;
        if (stderr.length > maxOutputChars) {
          stderr = stderr.slice(0, maxOutputChars);
          stderrTruncated = true;
        }
      }
    };

    child.stdout.on('data', collect('stdout'));
    child.stderr.on('data', collect('stderr'));

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
      setTimeout(() => finish(null, 'SIGKILL', null), 2000).unref();
    }, Math.max(1000, timeoutMs));

    child.on('error', (err) => finish(null, null, err.message));
    child.on('close', (code, signal) => finish(code, signal, null));
  });
}
