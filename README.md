# local-terminal-mcp

An MCP (Model Context Protocol) server that gives AI agents **multiple persistent local terminal sessions** on the machine it runs on.

Each session is a real shell process. Working directory and environment variables survive between commands, so an agent can start a dev server in one terminal, run tests in another, and inspect logs in a third.

## Features

- Multiple concurrent shell sessions, each with its own process, buffer and lifecycle
- Sessions survive MCP server restarts through a per-user background daemon
- Persistent state: `cd`, `export`, virtualenv activation and similar commands stick
- Incremental output reading with a sequence cursor, so nothing is read twice
- Agent-friendly helpers: run a one-off command, wait for output to settle, send signals, close sessions
- Zero native dependencies - plain Node.js child processes, works with `npx`
- Output buffering with a configurable cap per session
- Optional read-only mode for safer exploration

## Requirements

- Node.js 18.17 or newer
- macOS, Linux or Windows

## Quick start

Run directly from GitHub with `npx` (no install step):

```bash
npx -y github:technicalheist/local-terminal-mcp
```

The server speaks MCP over stdio, so it is normally launched by an MCP client rather than by hand. By default it connects to a per-user background daemon that owns the terminal sessions, so restarting the MCP server or reconnecting the client keeps them alive. Pass `--no-daemon` to run everything in one process.

## Demo

Run the built-in demo from a checkout:

```bash
npm run demo
# or point it at a project directory
npm run demo -- /path/to/project
```

It opens two terminal sessions, runs stateful shell commands, checks exit codes, pipes, unicode and a slow command, and runs read-only GitLab CLI checks when `glab` is installed. It prints a pass/fail table and exits non-zero on failure.

## Client configuration

### Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "terminal": {
      "command": "npx",
      "args": ["-y", "github:technicalheist/local-terminal-mcp"]
    }
  }
}
```

### Cursor

`.cursor/mcp.json` in a project or `~/.cursor/mcp.json` globally:

```json
{
  "mcpServers": {
    "terminal": {
      "command": "npx",
      "args": ["-y", "github:technicalheist/local-terminal-mcp"]
    }
  }
}
```

### OpenCode

`opencode.json`:

```json
{
  "mcp": {
    "terminal": {
      "type": "local",
      "command": ["npx", "-y", "github:technicalheist/local-terminal-mcp"],
      "enabled": true
    }
  }
}
```

### Codex CLI

`~/.codex/config.toml`:

```toml
[mcp_servers.terminal]
command = "npx"
args = ["-y", "github:technicalheist/local-terminal-mcp"]
```

## Tools

| Tool | Purpose |
| --- | --- |
| `terminal_spawn` | Open a session. Optional `name`, `shell`, `cwd`, `env`. Returns an id. |
| `terminal_list` | List sessions with status, pid and buffer usage. |
| `terminal_read` | Read output. Pass `since` (the previous `nextSince`) to get only new output. |
| `terminal_write` | Write raw input to a session. Set `wait: true` to include the resulting output. |
| `terminal_exec` | Run a command in an existing session, wait for it to finish and return output plus exit code. Set `waitForCompletion: false` for REPLs or servers. |
| `terminal_run` | Run a one-off command in a fresh shell and return stdout, stderr and exit code. |
| `terminal_signal` | Send `SIGINT`, `SIGTERM`, `SIGHUP` or `SIGKILL` to a session's process group. |
| `terminal_close` | Stop and remove a session. |

### Example

```text
1. terminal_spawn  { "name": "web",  "cwd": "~/project" }
2. terminal_spawn  { "name": "test", "cwd": "~/project" }
3. terminal_exec   { "id": "web",  "command": "npm run dev" }
4. terminal_exec   { "id": "test", "command": "npm test" }
5. terminal_read   { "id": "web", "since": 12 }
6. terminal_close  { "id": "web" }
```

## CLI options

```text
local-terminal-mcp [options]

--shell <path>         Shell executable for new sessions (default: $SHELL)
--cwd <path>           Default working directory (default: current directory)
--max-sessions <n>     Maximum concurrent sessions (default: 32)
--buffer-size <n>      Output buffer per session in characters (default: 1048576)
--read-only            Block spawn, write, exec, run, signal and close
--no-daemon            Run the MCP server in this process instead of the shared daemon
--quiet                Do not print the startup line to stderr
-h, --help             Show help
-v, --version          Print the version
```

## How it works

The server launches each session as a child shell with piped stdio (no pseudo-terminal). Commands are written to stdin and stdout/stderr are captured into a per-session ring buffer. Every output chunk gets a sequence number so clients can poll incrementally with `since` / `nextSince`.

By default the stdio process is a thin proxy to a per-user background daemon. The daemon owns the shells and output buffers, so restarting the MCP server or reconnecting the client keeps sessions alive. `terminal_list` shows them again. The socket lives under `~/.local-terminal-mcp/` with user-only permissions. Use `--no-daemon` to keep all state inside the stdio process instead.

`terminal_exec` appends a small hidden marker after each command to capture the exit code and detect completion. It waits up to two minutes by default and gives silent commands up to 30 seconds to start producing output. It removes the marker from the output and from the session buffer. If `completed` is `false`, the command is still running or waiting for input; poll with `terminal_read`.

Because there is no PTY:

- Full-screen interactive programs such as `vim`, `top` or `htop` will not render correctly.
- Line-oriented interactive programs (Python/Node REPLs, prompts) work through `terminal_write` with `newline: false`, or through `terminal_exec` with `waitForCompletion: false`.
- A command that reads stdin consumes the completion marker; use `terminal_write` for those commands.

## Security

This server grants full shell access to the user account that runs it. Only connect it to MCP clients and models you trust. The daemon socket is readable/writable only by your user, but any process running as you can connect to it. Use `--read-only` to block new sessions and command execution, and run it inside a container or VM when experimenting with untrusted agents.

## Install from GitHub Packages

The package is also published as `@technicalheist/local-terminal-mcp` on GitHub Packages. GitHub requires authentication for its npm registry, even for public packages:

```bash
export NODE_AUTH_TOKEN="$(gh auth token)"
npx --yes --registry=https://npm.pkg.github.com @technicalheist/local-terminal-mcp
```

Or install globally from the repository:

```bash
npm install -g github:technicalheist/local-terminal-mcp
local-terminal-mcp
```

## Development

```bash
git clone https://github.com/technicalheist/local-terminal-mcp.git
cd local-terminal-mcp
npm install
npm test
node bin/local-terminal-mcp.js --help
```

## License

MIT
