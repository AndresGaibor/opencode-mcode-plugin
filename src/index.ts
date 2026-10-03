import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { McodeAcpBridge } from "./acp.js";

const bridge = new McodeAcpBridge();
const defaultTimeoutMs = 10 * 60 * 1000;
const maxTimeoutMs = 4 * 60 * 60 * 1000;

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
          .describe("Timeout in milliseconds (default 10 minutes, maximum 4 hours)."),
      },
      async execute(args, context) {
        try {
          const result = await bridge.prompt({
            sessionID: context.sessionID,
            cwd: context.directory,
            prompt: args.prompt,
            signal: context.abort,
            timeoutMs: args.timeout ?? defaultTimeoutMs,
            requestPermission: async ({ toolCall, options }) => {
              const allow = options.find((option) => option.kind === "allow_once");
              const reject = options.find((option) => option.kind === "reject_once");
              if (!allow || !reject) {
                return { outcome: { outcome: "cancelled" } };
              }
              try {
                await context.ask({
                  permission: "mcode",
                  patterns: [toolCall.title ?? "MCode requested an action"],
                  always: [],
                  metadata: { title: toolCall.title ?? "MCode requested an action" },
                });
                return {
                  outcome: { outcome: "selected", optionId: allow.optionId },
                };
              } catch {
                return {
                  outcome: { outcome: "selected", optionId: reject.optionId },
                };
              }
            },
          });
          return {
            title: `MCode (${result.stopReason})`,
            output:
              (result.output || `MCode finished with no text output (${result.stopReason}).`) +
              (result.outputTruncated ? "\n\n[Output truncated at 100,000 characters.]" : ""),
            metadata: {
              sessionId: result.sessionId,
              stopReason: result.stopReason,
              outputTruncated: result.outputTruncated,
            },
          };
        } catch (error) {
          if (context.abort.aborted) throw error;
          return {
            title: "MCode ACP error",
            output: error instanceof Error ? error.message : String(error),
            metadata: { error: true },
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
