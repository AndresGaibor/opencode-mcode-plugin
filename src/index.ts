import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import {
  McodeAcpBridge,
  McodeTimeoutError,
  defaultTimeoutMs,
  whenAborted,
} from "./acp.js";

const bridge = new McodeAcpBridge();
const maxTimeoutMs = 4 * 60 * 60 * 1000;

type Outcome = "success" | "partial" | "timeout" | "error";

const McodePlugin: Plugin = async () => ({
  tool: {
    mcode: tool({
      description:
        "Delegate a task to MiniMax Code over ACP. MCode sessions are reused within the current OpenCode session. Review changes made by MCode.",
      args: {
        prompt: tool.schema.string().min(1).describe("Task for MiniMax Code."),
        timeout: tool.schema
          .number()
          .int()
          .positive()
          .max(maxTimeoutMs)
          .optional()
          .describe(
            "Total budget in milliseconds from invocation, including queue wait (default 10 minutes, maximum 4 hours).",
          ),
      },
      async execute(args, context) {
        try {
          const result = await bridge.prompt({
            sessionID: context.sessionID,
            cwd: context.directory,
            prompt: args.prompt,
            signal: context.abort,
            timeoutMs: args.timeout ?? defaultTimeoutMs,
            requestPermission: async (permission) => {
              const { toolCall, options } = permission.params;
              const allow = options.find(
                (option) => option.kind === "allow_once",
              );
              const reject = options.find(
                (option) => option.kind === "reject_once",
              );
              if (!allow || !reject) {
                return { outcome: { outcome: "cancelled" } };
              }
              // Never grant by default: without an explicit user decision
              // the safe answer is "cancelled".
              if (context.abort.aborted || permission.signal.aborted) {
                return { outcome: { outcome: "cancelled" } };
              }
              // context.ask() cannot be cancelled (OpenCode API has no
              // signal for it), so race it against both abort sources. A
              // late ask resolution after an abort is ignored: this handler
              // already returned "cancelled" and has no further effect.
              const winner = await Promise.race([
                context
                  .ask({
                    permission: "mcode",
                    patterns: [toolCall.title ?? "MCode requested an action"],
                    always: [],
                    metadata: {
                      title: toolCall.title ?? "MCode requested an action",
                    },
                  })
                  .then(
                    () => "ask-allow" as const,
                    () => "ask-deny" as const,
                  ),
                whenAborted(context.abort).then(() => "aborted" as const),
                whenAborted(permission.signal).then(() => "aborted" as const),
              ]);
              if (
                winner !== "ask-allow" ||
                context.abort.aborted ||
                permission.signal.aborted
              ) {
                if (context.abort.aborted || permission.signal.aborted) {
                  return { outcome: { outcome: "cancelled" } };
                }
                return {
                  outcome: { outcome: "selected", optionId: reject.optionId },
                };
              }
              return {
                outcome: { outcome: "selected", optionId: allow.optionId },
              };
            },
          });
          const outcome: Outcome =
            result.stopReason === "end_turn" && !result.outputTruncated
              ? "success"
              : "partial";
          return {
            title: `MCode (${result.stopReason})`,
            output:
              (result.output ||
                `MCode finished with no text output (${result.stopReason}).`) +
              (result.outputTruncated
                ? "\n\n[Output truncated at 100,000 characters.]"
                : "") +
              (outcome === "partial"
                ? `\n\n[Partial result: stopReason=${result.stopReason}, truncated=${result.outputTruncated}.]`
                : ""),
            metadata: {
              outcome,
              sessionId: result.sessionId,
              stopReason: result.stopReason,
              outputTruncated: result.outputTruncated,
            },
          };
        } catch (error) {
          // Cancellation propagates as a throw so OpenCode marks the tool
          // cancelled; it is never converted into an approval or a result.
          if (context.abort.aborted) throw error;
          if (error instanceof McodeTimeoutError) {
            return {
              title: "MCode ACP timeout",
              output: error.message,
              metadata: {
                outcome: "timeout",
                error: true,
                code: error.code,
                phase: error.phase,
                elapsedMs: error.elapsedMs,
              },
            };
          }
          return {
            title: "MCode ACP error",
            output: error instanceof Error ? error.message : String(error),
            metadata: { outcome: "error", error: true },
          };
        }
      },
    }),
  },
  config: async (config) => {
    if (config.command?.mcode) return;
    config.command = {
      ...config.command,
      mcode: {
        description: "Delegate a task to MiniMax Code over ACP",
        template:
          "Use the mcode tool to perform this task, then report its result: $ARGUMENTS",
      },
    };
  },
});

export { McodePlugin };
export default McodePlugin;
