# OpenCode MCode Plugin

Connects OpenCode to the MiniMax Code CLI through its Agent Client Protocol (ACP) server. OpenCode remains the main agent; MCode runs delegated work in the current project directory.

## Requirements

- OpenCode 1.x
- Bun 1.x
- MiniMax Code CLI with ACP support (`mcode --version`)
- An authenticated MCode account (`mcode acp login`)

## Install from source

```sh
git clone https://github.com/AndresGaibor/opencode-mcode-plugin.git
cd opencode-mcode-plugin
bun install
bun run build
```

Add the built plugin to `~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["file:///absolute/path/to/opencode-mcode-plugin/dist/index.js"]
}
```

Restart OpenCode. The plugin registers an `mcode` tool and `/mcode` command. Example:

```text
/mcode review the current changes and report any bugs
```

## Behavior

- Starts `mcode acp` for each delegation and uses ACP `session/load` to resume MCode's session on later calls from the same OpenCode session.
- Routes MCode permission requests through OpenCode's confirmation prompt.
- Cancels the ACP task when the OpenCode tool is aborted.
- Uses a 10-minute timeout by default. The tool accepts `timeout` in milliseconds, up to 4 hours.
- Keeps the OpenCode-to-MCode session mapping in memory for the lifetime of the plugin process. Restarting OpenCode loses that mapping; the next delegation starts a new MCode session.

Set `MCODE_COMMAND` to the executable path if `mcode` is not available in OpenCode's `PATH`.

The plugin does not read or manage MCode credentials. Authenticate with the MCode CLI before using the tool. MCode's own `mcode plugin` command manages plugins for MCode, not this OpenCode plugin.

## Development

```sh
bun test
bun run typecheck
bun run build
```
