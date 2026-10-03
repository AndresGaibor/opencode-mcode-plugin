import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

const loaded = new Set<string>();
let cancelPrompt: (() => void) | undefined;
const app = acp
  .agent({ name: "fake-mcode" })
  .onRequest(acp.methods.agent.initialize, () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: { loadSession: true },
    agentInfo: { name: "fake-mcode", version: "1.0.0" },
  }))
  .onRequest(acp.methods.agent.session.new, () => ({
    sessionId: "fake-session",
  }))
  .onRequest(acp.methods.agent.session.load, async ({ params, client }) => {
    loaded.add(params.sessionId);
    await client.notify(acp.methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "previous response" },
      },
    });
    return {};
  })
  .onNotification(acp.methods.agent.session.cancel, () => cancelPrompt?.())
  .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
    const prompt = params.prompt
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    if (prompt === "wait") {
      await new Promise<void>((resolve) => {
        cancelPrompt = resolve;
      });
      return { stopReason: "cancelled" };
    }
    const prefix = loaded.has(params.sessionId) ? "loaded" : "new";
    await client.notify(acp.methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: prompt === "long" ? "x".repeat(100_100) : `${prefix}:${prompt}`,
        },
      },
    });
    return { stopReason: "end_turn" };
  });

app.connect(
  acp.ndJsonStream(
    Writable.toWeb(process.stdout),
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  ),
);
