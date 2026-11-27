# local-terminal-mcp

An MCP (Model Context Protocol) server that gives AI agents **multiple persistent local terminal sessions** on the machine it runs on.

Each session is a real shell process. Working directory and environment variables survive between commands, so an agent can start a dev server in one terminal, run tests in another, and inspect logs in a third.

## Features

- Multiple concurrent shell sessions, each with its own process, buffer and lifecycle
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

The server speaks MCP over stdio, so it is normally launched by an MCP client rather than by hand.

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
| `terminal_exec` | Run a command in an existing session and return its output. |
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
--quiet                Do not print the startup line to stderr
-h, --help             Show help
-v, --version          Print the version
```

## How it works

The server launches each session as a child shell with piped stdio (no pseudo-terminal). Commands are written to stdin and stdout/stderr are captured into a per-session ring buffer. Every output chunk gets a sequence number so clients can poll incrementally with `since` / `nextSince`.

Because there is no PTY:

- Full-screen interactive programs such as `vim`, `top` or `htop` will not render correctly.
- Line-oriented interactive programs (Python/Node REPLs, prompts) work through `terminal_write` with `newline: false`.
- `terminal_exec` returns when output goes quiet. A long-running command may still be running; poll `terminal_read` with the returned cursor.

## Security

This server grants full shell access to the user account that runs it. Only connect it to MCP clients and models you trust. Use `--read-only` to block new sessions and command execution, and run it inside a container or VM when experimenting with untrusted agents.

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
