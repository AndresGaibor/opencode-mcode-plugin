import assert from "node:assert/strict";
import { describe, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { McodeAcpBridge } from "../src/acp.js";

const fixture = fileURLToPath(new URL("./fixtures/fake-acp-agent.ts", import.meta.url));

describe("McodeAcpBridge", () => {
  test("loads the same MCode session for later calls in an OpenCode session", async () => {
    const bridge = new McodeAcpBridge({
      command: process.execPath,
      args: ["run", fixture],
    });

    const first = await bridge.prompt({
      sessionID: "opencode-1",
      cwd: process.cwd(),
      prompt: "first task",
      signal: new AbortController().signal,
    });
    const second = await bridge.prompt({
      sessionID: "opencode-1",
      cwd: process.cwd(),
      prompt: "follow-up",
      signal: new AbortController().signal,
    });

    assert.equal(first.sessionId, "fake-session");
    assert.equal(first.output, "new:first task");
    assert.equal(second.sessionId, "fake-session");
    assert.equal(second.output, "loaded:follow-up");
  });

  test("serializes overlapping prompts in one OpenCode session", async () => {
    const bridge = new McodeAcpBridge({
      command: process.execPath,
      args: ["run", fixture],
    });
    const prompt = (text: string) =>
      bridge.prompt({
        sessionID: "opencode-parallel",
        cwd: process.cwd(),
        prompt: text,
        signal: new AbortController().signal,
      });

    const [first, second] = await Promise.all([prompt("first"), prompt("second")]);

    assert.equal(first.output, "new:first");
    assert.equal(second.output, "loaded:second");
  });

  test("cancels the ACP prompt when the OpenCode tool is aborted", async () => {
    const bridge = new McodeAcpBridge({
      command: process.execPath,
      args: ["run", fixture],
    });
    const controller = new AbortController();
    const pending = bridge.prompt({
      sessionID: "opencode-cancel",
      cwd: process.cwd(),
      prompt: "wait",
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(new Error("cancelled by test")), 1000);

    await assert.rejects(pending, /cancelled by test/);
  });

  test("caps accumulated assistant output", async () => {
    const bridge = new McodeAcpBridge({
      command: process.execPath,
      args: ["run", fixture],
    });
    const result = await bridge.prompt({
      sessionID: "opencode-long-output",
      cwd: process.cwd(),
      prompt: "long",
      signal: new AbortController().signal,
    });

    assert.equal(result.output.length, 100_000);
    assert.equal(result.outputTruncated, true);
  });
});
