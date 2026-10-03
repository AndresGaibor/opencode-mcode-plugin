import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { terminateProcessTree } from "./process.js";

const maxOutputLength = 100_000;

export const defaultTimeoutMs = 10 * 60 * 1000;

/** Identifiable timeout: `code` is stable for programmatic handling. */
export class McodeTimeoutError extends Error {
  readonly code = "MCODE_TIMEOUT" as const;
  constructor(
    readonly phase: "queued" | "running",
    readonly elapsedMs: number,
    timeoutMs: number,
  ) {
    super(
      `MCODE_TIMEOUT [phase=${phase}] MCode ACP timed out after ${timeoutMs}ms.`,
    );
  }
}

export type PermissionHandler = (
  context: acp.ClientRequestContext<acp.RequestPermissionRequest>,
) => Promise<acp.RequestPermissionResponse>;

/** Resolves when the signal aborts (already-aborted signals resolve now). */
export function whenAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

export type McodePrompt = {
  sessionID: string;
  cwd: string;
  prompt: string;
  signal: AbortSignal;
  /**
   * Total budget in milliseconds from when the tool is invoked, including
   * time spent waiting for the session turn. Defaults to 10 minutes.
   */
  timeoutMs?: number;
  requestPermission?: PermissionHandler;
};

export type McodeResult = {
  sessionId: string;
  output: string;
  outputTruncated: boolean;
  stopReason: string;
};

export class McodeAcpBridge {
  private readonly sessions = new Map<string, string>();
  private readonly tails = new Map<string, Promise<void>>();
  private readonly command: string;
  private readonly args: string[];

  constructor(options: { command?: string; args?: string[] } = {}) {
    this.command = options.command ?? process.env.MCODE_COMMAND ?? "mcode";
    this.args = options.args ?? ["acp"];
  }

  async prompt(input: McodePrompt): Promise<McodeResult> {
    const timeoutMs = input.timeoutMs ?? defaultTimeoutMs;
    const start = Date.now();
    const deadline = start + timeoutMs;
    const previous = this.tails.get(input.sessionID) ?? Promise.resolve();
    let releaseTurn!: () => void;
    const turn = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const chained = previous.then(
      () => turn,
      () => turn,
    );
    this.tails.set(input.sessionID, chained);
    try {
      await this.waitForTurn(previous, input.signal, start, deadline, timeoutMs);
      return await this.run(input, start, deadline, timeoutMs);
    } finally {
      releaseTurn();
      if (this.tails.get(input.sessionID) === chained) {
        this.tails.delete(input.sessionID);
      }
    }
  }

  /**
   * Waits for the previous turn without spawning anything. An abort or the
   * total timeout rejects here, so a cancelled queued call never starts a
   * session, never sends its prompt, and never blocks or disturbs the
   * active turn. A previous turn's failure never blocks the queue either.
   */
  private waitForTurn(
    previous: Promise<unknown>,
    signal: AbortSignal,
    start: number,
    deadline: number,
    timeoutMs: number,
  ): Promise<void> {
    signal.throwIfAborted();
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        reject(new McodeTimeoutError("queued", Date.now() - start, timeoutMs));
        return;
      }
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(new McodeTimeoutError("queued", Date.now() - start, timeoutMs));
      }, remaining);
      const onAbort = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(signal.reason);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      previous.then(
        () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          resolve();
        },
        () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          resolve();
        },
      );
    });
  }

  private async run(
    input: McodePrompt,
    start: number,
    deadline: number,
    timeoutMs: number,
  ): Promise<McodeResult> {
    // Re-check: the turn may have been granted after an abort raced it.
    input.signal.throwIfAborted();
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new McodeTimeoutError("running", Date.now() - start, timeoutMs);
    }
    const child = spawn(this.command, this.args, {
      cwd: input.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
      // Group leader on POSIX so termination signals reach only the tree
      // this plugin started (see terminateProcessTree).
      detached: process.platform !== "win32",
    });
    child.stderr?.resume();
    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin!),
      Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
    );
    let output = "";
    let outputTruncated = false;
    const app = acp
      .client({ name: "opencode-mcode-plugin" })
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        if (
          params.update.sessionUpdate === "agent_message_chunk" &&
          params.update.content.type === "text"
        ) {
          const chunk = params.update.content.text;
          const spare = maxOutputLength - output.length;
          output += chunk.slice(0, spare);
          outputTruncated ||= chunk.length > spare;
        }
      });
    if (input.requestPermission) {
      const handle = input.requestPermission;
      const cancelled: acp.RequestPermissionResponse = {
        outcome: { outcome: "cancelled" },
      };
      app.onRequest(acp.methods.client.session.requestPermission, (context) =>
        // Never let a permission decision outlive its call: whichever
        // settles first wins, and a late handler response after an abort
        // has no effect on the already-cancelled turn.
        Promise.race([
          handle(context),
          whenAborted(context.signal).then(() => cancelled),
          whenAborted(input.signal).then(() => cancelled),
        ]),
      );
    }

    const connection = app.connect(stream);
    let sessionId: string | undefined;
    const executionTimeout = AbortSignal.timeout(remaining);
    const signal = AbortSignal.any([input.signal, executionTimeout]);
    let result: McodeResult | undefined;
    let failure: unknown;
    try {
      await connection.agent.request(
        acp.methods.agent.initialize,
        {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {},
          clientInfo: {
            name: "opencode-mcode-plugin",
            version: "0.1.0",
          },
        },
        { cancellationSignal: signal },
      );

      const previousSession = this.sessions.get(input.sessionID);
      if (previousSession) {
        await connection.agent.request(
          acp.methods.agent.session.load,
          { sessionId: previousSession, cwd: input.cwd, mcpServers: [] },
          { cancellationSignal: signal },
        );
        sessionId = previousSession;
      } else {
        const session = await connection.agent.request(
          acp.methods.agent.session.new,
          { cwd: input.cwd, mcpServers: [] },
          { cancellationSignal: signal },
        );
        sessionId = session.sessionId;
        this.sessions.set(input.sessionID, sessionId);
      }

      signal.throwIfAborted();
      // Cooperative prompt cancellation: asks the agent to stop the turn.
      // Executor shutdown happens separately below in all cases.
      const cancel = () => {
        if (sessionId) {
          void connection.agent.notify(acp.methods.agent.session.cancel, {
            sessionId,
          });
        }
      };
      signal.addEventListener("abort", cancel, { once: true });
      output = "";
      outputTruncated = false;
      try {
        const response = await connection.agent.request(
          acp.methods.agent.session.prompt,
          {
            sessionId,
            prompt: [{ type: "text", text: input.prompt }],
          },
          { cancellationSignal: signal },
        );
        signal.throwIfAborted();
        result = {
          sessionId,
          output,
          outputTruncated,
          stopReason: response.stopReason,
        };
      } finally {
        signal.removeEventListener("abort", cancel);
      }
    } catch (error) {
      if (input.signal.aborted) {
        failure = input.signal.reason;
      } else if (!child.pid) {
        failure = new Error(
          `Could not start MCode ACP process "${this.command}".`,
        );
      } else if (executionTimeout.aborted) {
        failure = new McodeTimeoutError(
          "running",
          Date.now() - start,
          timeoutMs,
        );
      } else {
        failure = new Error(`MCode ACP failed: ${errorMessage(error)}`);
      }
    } finally {
      connection.close();
    }

    // Executor shutdown is distinct from prompt cancellation: the process
    // (and only its own tree) is always reaped, and only an observed exit
    // counts. A forced close invalidates the cached session so the next
    // call starts fresh on a new process.
    const termination = await terminateProcessTree(child, { graceMs: 2000 });
    if (termination.forced || !termination.exited) {
      this.sessions.delete(input.sessionID);
    }
    if (!termination.exited) {
      throw new Error(
        `MCode ACP executor (pid ${child.pid ?? "unknown"}) did not exit after SIGKILL; its session mapping was discarded.`,
      );
    }
    if (failure !== undefined) throw failure;
    return result!;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
