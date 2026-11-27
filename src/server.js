import fs from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { TerminalManager, runOnce } from './terminal.js';

const VERSION = JSON.parse(
  fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;

const INSTRUCTIONS = `Local Terminal MCP gives you persistent shell sessions on the machine that runs this server.

Typical workflow:
1. terminal_spawn - open a session (optional name, shell, cwd). Reuse it for related commands.
2. terminal_exec - run a command inside a session and get the output plus its exit code. Shell state (cwd, env vars) persists between calls.
3. terminal_read - fetch more output later, optionally only new output via the "since" cursor.
4. terminal_write - type raw input into a session, for REPLs and interactive prompts.
5. terminal_run - run a single command in a throwaway shell and get stdout, stderr and the exit code.
6. terminal_list / terminal_signal / terminal_close - manage sessions.

Notes:
- Sessions are real local shells. They can read, write and delete files and run any program the server user can run.
- Do not run two commands in the same session at the same time. Output interleaves; use separate sessions instead.
- terminal_exec waits for the command to finish and returns "completed" plus the command exit code. If completed is false, it is still running or waiting for input; poll with terminal_read using the returned nextSince value.
- For interactive programs or commands that read stdin, use terminal_write, or terminal_exec with waitForCompletion: false.
- Prefer terminal_run for short one-off commands and terminal_spawn + terminal_exec for anything stateful.
- Close sessions you no longer need.`;

function toJson(value) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  };
}

function toError(err) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [{ type: 'text', text: `Error: ${message}` }],
  };
}

function safe(handler) {
  return async (args) => {
    try {
      return toJson(await handler(args));
    } catch (err) {
      return toError(err);
    }
  };
}

const sessionRef = z
  .string()
  .min(1)
  .describe('Session id (for example "term_1a2b3c4d") or the friendly name given at spawn time.');

const idleMs = z
  .number()
  .int()
  .min(50)
  .max(10000)
  .optional()
  .describe('Consider the command finished after this many ms without new output. Default 400.');

const timeoutMs = z
  .number()
  .int()
  .min(100)
  .max(600000)
  .optional()
  .describe('Maximum time to wait in milliseconds. Default 15000 for sessions, 30000 for run.');

export function createTerminalServer(options = {}) {
  const manager =
    options.manager ||
    new TerminalManager({
      shell: options.shell,
      cwd: options.cwd,
      maxSessions: options.maxSessions,
      bufferSize: options.bufferSize,
      readOnly: options.readOnly,
      env: options.env,
    });

  const server = new McpServer(
    { name: 'local-terminal-mcp', version: VERSION },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool(
    'terminal_spawn',
    {
      title: 'Open a terminal session',
      description:
        'Open a new persistent local shell session. The session keeps its working directory and environment between commands. Returns the session id used by the other terminal tools.',
      inputSchema: {
        name: z
          .string()
          .min(1)
          .max(64)
          .optional()
          .describe('Friendly name for the session. Must be unique enough to use instead of the id.'),
        shell: z
          .string()
          .min(1)
          .optional()
          .describe('Shell executable to start, for example /bin/zsh, /bin/bash or cmd.exe. Defaults to $SHELL.'),
        cwd: z
          .string()
          .optional()
          .describe('Working directory for the session. Defaults to the directory where the server started.'),
        env: z
          .record(z.string(), z.string())
          .optional()
          .describe('Extra environment variables merged into the inherited environment.'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    safe(async ({ name, shell, cwd, env }) => {
      const session = await manager.spawn({ name, shell, cwd, env });
      return {
        session: session.snapshot(),
        hint: 'Use terminal_exec with this id to run commands.',
      };
    }),
  );

  server.registerTool(
    'terminal_list',
    {
      title: 'List terminal sessions',
      description:
        'List all terminal sessions with their id, name, shell, initial working directory, process id, status, exit code and buffer size.',
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    safe(async () => {
      const sessions = manager.list();
      return { count: sessions.length, sessions };
    }),
  );

  server.registerTool(
    'terminal_read',
    {
      title: 'Read terminal output',
      description:
        'Read buffered output from a session. Without "since", returns the last "lines" lines. Pass the previously returned nextSince value to get only new output since that point.',
      inputSchema: {
        id: sessionRef,
        since: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Only return output with a sequence number at or after this cursor.'),
        lines: z
          .number()
          .int()
          .min(1)
          .max(5000)
          .optional()
          .describe('When "since" is omitted, return at most this many trailing lines. Default 200.'),
        raw: z
          .boolean()
          .optional()
          .describe('Return raw bytes with ANSI escapes and carriage returns intact. Default false.'),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    safe(async ({ id, since, lines, raw }) => {
      const session = manager.resolve(id);
      const result = session.read({ since, lines, raw });
      return {
        id: session.id,
        name: session.name,
        status: session.status,
        exitCode: session.exitCode,
        output: result.output,
        nextSince: result.nextSince,
        firstAvailableSeq: result.firstAvailableSeq,
        droppedChars: result.droppedChars,
      };
    }),
  );

  server.registerTool(
    'terminal_write',
    {
      title: 'Write to a terminal',
      description:
        'Write raw input to a running session. By default a newline is appended so the shell executes it. Set wait to true to also return the output produced by this write.',
      inputSchema: {
        id: sessionRef,
        input: z.string().describe('Text to send to the session stdin.'),
        newline: z
          .boolean()
          .optional()
          .describe('Append a newline after the input. Default true. Set false for REPLs or raw typing.'),
        wait: z
          .boolean()
          .optional()
          .describe('Wait for output to go quiet and include the new output in the response. Default false.'),
        idleMs,
        timeoutMs,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    safe(async ({ id, input, newline, wait, idleMs: quiet, timeoutMs: limit }) => {
      manager.ensureWritable();
      const session = manager.resolve(id);
      const cursor = session.nextSeq;
      await session.write(input, { newline: newline !== false });

      let waitResult = null;
      if (wait) {
        waitResult = await session.waitForIdle({
          idleMs: quiet ?? 400,
          timeoutMs: limit ?? 15000,
        });
      }

      const read = session.read({ since: cursor });
      return {
        id: session.id,
        status: session.status,
        exitCode: session.exitCode,
        output: read.output,
        nextSince: read.nextSince,
        settled: waitResult ? waitResult.settled : null,
        waitReason: waitResult ? waitResult.reason : null,
        waitedMs: waitResult ? waitResult.waitedMs : 0,
        hint:
          waitResult && waitResult.reason === 'no-output'
            ? 'No output yet. The command may still be running; call terminal_read with this nextSince value to poll.'
            : undefined,
      };
    }),
  );

  server.registerTool(
    'terminal_exec',
    {
      title: 'Run a command in a session',
      description:
        'Type a command into an existing session, wait for it to finish and return its output and exit code. The session keeps its working directory and environment, so use this for multi-step work. Set waitForCompletion to false for interactive programs or long-running servers.',
      inputSchema: {
        id: sessionRef,
        command: z.string().min(1).describe('Command line to execute in the session shell.'),
        waitForCompletion: z
          .boolean()
          .optional()
          .describe(
            'Wait for the command to finish and report its exit code. Default true. Set false for REPLs, prompts or servers that keep running.',
          ),
        idleMs,
        timeoutMs,
        raw: z.boolean().optional().describe('Return raw output with ANSI escapes. Default false.'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    safe(async ({ id, command, idleMs: quiet, timeoutMs: limit, raw, waitForCompletion }) => {
      manager.ensureWritable();
      const session = manager.resolve(id);
      const result = await session.execCommand(command, {
        idleMs: quiet ?? 400,
        timeoutMs: limit ?? 15000,
        raw,
        waitForCompletion,
      });

      return {
        id: session.id,
        name: session.name,
        status: result.sessionStatus,
        output: result.output,
        nextSince: result.nextSince,
        completed: result.completed,
        exitCode: result.exitCode,
        sessionExitCode: result.sessionExitCode,
        waitedMs: result.waitedMs,
        hint: result.completed
          ? undefined
          : 'The command is still running or waiting for input. Poll with terminal_read using this nextSince value.',
      };
    }),
  );

  server.registerTool(
    'terminal_run',
    {
      title: 'Run a one-off command',
      description:
        'Run a command in a fresh non-interactive shell and wait for it to finish. Returns stdout, stderr, exit code and duration. Use this for short commands when no persistent session state is needed.',
      inputSchema: {
        command: z.string().min(1).describe('Command line to execute.'),
        cwd: z.string().optional().describe('Working directory. Defaults to the server working directory.'),
        shell: z.string().optional().describe('Shell executable. Defaults to $SHELL.'),
        timeoutMs,
        maxOutputChars: z
          .number()
          .int()
          .min(1000)
          .max(5000000)
          .optional()
          .describe('Cap on captured stdout and stderr characters. Default 200000.'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    safe(async ({ command, cwd, shell, timeoutMs: limit, maxOutputChars }) => {
      manager.ensureWritable();
      const result = await runOnce({
        command,
        cwd,
        shell,
        timeoutMs: limit ?? 30000,
        maxOutputChars,
      });
      return result;
    }),
  );

  server.registerTool(
    'terminal_signal',
    {
      title: 'Send a signal to a session',
      description:
        'Send a POSIX signal to the session process group. Use SIGINT to interrupt a running command, SIGTERM to ask it to stop, or SIGKILL to force it. On Windows the process tree is terminated.',
      inputSchema: {
        id: sessionRef,
        signal: z
          .enum(['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGKILL'])
          .optional()
          .describe('Signal to send. Default SIGINT.'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    safe(async ({ id, signal }) => {
      const snapshot = manager.signal(id, signal ?? 'SIGINT');
      return { signal: signal ?? 'SIGINT', session: snapshot };
    }),
  );

  server.registerTool(
    'terminal_close',
    {
      title: 'Close a terminal session',
      description:
        'Terminate a session and remove it from the session list. Running child processes in its process group are stopped too.',
      inputSchema: {
        id: sessionRef,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    safe(async ({ id }) => {
      manager.ensureWritable();
      const snapshot = await manager.close(id);
      return { closed: true, session: snapshot, remaining: manager.list().length };
    }),
  );

  return { server, manager };
}
