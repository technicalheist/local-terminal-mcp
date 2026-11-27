import { VERSION } from './version.js';

export const HELP = `local-terminal-mcp v${VERSION}

MCP server that gives AI agents multiple persistent local terminal sessions.

Usage:
  local-terminal-mcp [options]

Options:
  --shell <path>         Shell executable for new sessions (default: $SHELL)
  --cwd <path>           Default working directory (default: current directory)
  --max-sessions <n>     Maximum concurrent sessions (default: 32)
  --buffer-size <n>      Output buffer per session in characters (default: 1048576)
  --read-only            Block spawn, write, exec, run, signal and close
  --no-daemon            Run the MCP server in this process instead of the shared daemon
  --quiet                Do not print the startup line to stderr
  -h, --help             Show this help
  -v, --version          Print the version

The server speaks the Model Context Protocol over stdio. Configure your MCP
client to launch it with the command "npx -y github:technicalheist/local-terminal-mcp".

By default the server connects to a per-user background daemon that owns the
terminal sessions. Restarting the MCP server does not lose those sessions.
Use --no-daemon to keep everything in one process.
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
      case '--no-daemon':
        options.noDaemon = true;
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
