import fs from 'node:fs';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createTerminalServer } from './server.js';
import { defaultShell } from './terminal.js';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
export const VERSION = pkg.version;

const HELP = `local-terminal-mcp v${VERSION}

MCP server that gives AI agents multiple persistent local terminal sessions.

Usage:
  local-terminal-mcp [options]

Options:
  --shell <path>         Shell executable for new sessions (default: $SHELL)
  --cwd <path>           Default working directory (default: current directory)
  --max-sessions <n>     Maximum concurrent sessions (default: 32)
  --buffer-size <n>      Output buffer per session in characters (default: 1048576)
  --read-only            Block spawn, write, exec, run, signal and close
  --quiet                Do not print the startup line to stderr
  -h, --help             Show this help
  -v, --version          Print the version

The server speaks the Model Context Protocol over stdio. Configure your MCP
client to launch it with the command "npx -y github:technicalheist/local-terminal-mcp".
`;

function readValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

export function parseArgs(argv) {
  const options = {
    quiet: false,
    help: false,
    version: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const [flag, inline] = arg.includes('=') ? arg.split(/=(.*)/s, 2) : [arg, undefined];
    const take = () => {
      if (inline !== undefined) return inline;
      const value = readValue(argv, i, flag);
      i += 1;
      return value;
    };

    switch (flag) {
      case '--shell':
        options.shell = take();
        break;
      case '--cwd':
        options.cwd = take();
        break;
      case '--max-sessions': {
        const value = Number(take());
        if (!Number.isInteger(value) || value < 1) throw new Error('--max-sessions must be a positive integer');
        options.maxSessions = value;
        break;
      }
      case '--buffer-size': {
        const value = Number(take());
        if (!Number.isInteger(value) || value < 1024) throw new Error('--buffer-size must be an integer of at least 1024');
        options.bufferSize = value;
        break;
      }
      case '--read-only':
        options.readOnly = true;
        break;
      case '--quiet':
        options.quiet = true;
        break;
      case '-h':
      case '--help':
        options.help = true;
        break;
      case '-v':
      case '--version':
        options.version = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

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

export { defaultShell };
