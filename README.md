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

- Starts `mcode acp` for each delegation and uses ACP `session/load` to resume MCode's session on later calls from the same OpenCode session. Calls in one OpenCode session run one at a time; a queued call that is aborted (or times out) never spawns a process and never disturbs the active turn.
- Routes MCode permission requests through OpenCode's confirmation prompt. Nothing is granted by default: without an explicit approval the answer is deny/cancelled, and an abort is never converted into an approval. A late permission answer after an abort has no effect on the already-cancelled turn.
- Cancels the ACP task when the OpenCode tool is aborted (`session/cancel` plus request cancellation), then always shuts down that call's executor process tree (SIGTERM, escalating to SIGKILL) and verifies the exit. If the executor had to be force-closed, the cached session mapping is discarded so the next call starts fresh on a new process.
- Timeout is a **total budget from invocation, including queue wait** (default 10 minutes, up to 4 hours). Expiry returns an identifiable `MCODE_TIMEOUT` result with `phase: "queued" | "running"` instead of hanging.
- Tool results carry `metadata.outcome`: `success` (clean `end_turn`), `partial` (other stop reason or truncated output), `timeout`, or `error`. Aborts rethrow so OpenCode marks the tool cancelled.
- Keeps the OpenCode-to-MCode session mapping in memory for the lifetime of the plugin process. Restarting OpenCode loses that mapping; the next delegation starts a new MCode session.

Limitations:

- `context.ask()` has no cancellation signal in the OpenCode API, so an OpenCode permission dialog opened before an abort may still be visible; its answer is ignored once the call is aborted.
- Windows process-tree termination is best-effort (`taskkill /F /T` fallback); POSIX uses process-group signals scoped to the group this plugin created.

Set `MCODE_COMMAND` to the executable path if `mcode` is not available in OpenCode's `PATH`.

The plugin does not read or manage MCode credentials. Authenticate with the MCode CLI before using the tool. MCode's own `mcode plugin` command manages plugins for MCode, not this OpenCode plugin.

## Development

```sh
bun test
bun run typecheck
bun run build
```
