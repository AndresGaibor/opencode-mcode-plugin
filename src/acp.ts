import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

const maxOutputLength = 100_000;

type PermissionHandler = (
  request: acp.RequestPermissionRequest,
) => Promise<acp.RequestPermissionResponse>;

export type McodePrompt = {
  sessionID: string;
  cwd: string;
  prompt: string;
  signal: AbortSignal;
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
  private readonly queues = new Map<string, Promise<McodeResult>>();
  private readonly command: string;
  private readonly args: string[];

  constructor(options: { command?: string; args?: string[] } = {}) {
    this.command = options.command ?? process.env.MCODE_COMMAND ?? "mcode";
    this.args = options.args ?? ["acp"];
  }

  async prompt(input: McodePrompt): Promise<McodeResult> {
    const previous = this.queues.get(input.sessionID) ?? Promise.resolve(undefined);
    const current = previous.catch(() => undefined).then(() => this.run(input));
    this.queues.set(input.sessionID, current);
    try {
      return await current;
    } finally {
      if (this.queues.get(input.sessionID) === current) {
        this.queues.delete(input.sessionID);
      }
    }
  }

  private async run(input: McodePrompt): Promise<McodeResult> {
    input.signal.throwIfAborted();
    const child = spawn(this.command, this.args, {
      cwd: input.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
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
          const remaining = maxOutputLength - output.length;
          output += chunk.slice(0, remaining);
          outputTruncated ||= chunk.length > remaining;
        }
      });
    if (input.requestPermission) {
      app.onRequest(
        acp.methods.client.session.requestPermission,
        ({ params }) => input.requestPermission!(params),
      );
    }

    const connection = app.connect(stream);
    let sessionId: string | undefined;
    const timeout = AbortSignal.timeout(input.timeoutMs ?? 10 * 60 * 1000);
    const signal = AbortSignal.any([input.signal, timeout]);
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
        const result = await connection.agent.request(
          acp.methods.agent.session.prompt,
          {
            sessionId,
            prompt: [{ type: "text", text: input.prompt }],
          },
          { cancellationSignal: signal },
        );
        signal.throwIfAborted();
        return { sessionId, output, outputTruncated, stopReason: result.stopReason };
      } finally {
        signal.removeEventListener("abort", cancel);
      }
    } catch (error) {
      if (input.signal.aborted) throw input.signal.reason;
      if (!child.pid) {
        throw new Error(`Could not start MCode ACP process "${this.command}".`);
      }
      if (timeout.aborted && !input.signal.aborted) {
        throw new Error(`MCode ACP timed out after ${input.timeoutMs ?? 600_000}ms.`);
      }
      throw new Error(`MCode ACP failed: ${errorMessage(error)}`);
    } finally {
      connection.close();
      child.kill();
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve();
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 1000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
