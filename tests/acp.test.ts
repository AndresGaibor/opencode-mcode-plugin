import assert from "node:assert/strict";
import { describe, test } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
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

  test("aborts a queued call without starting its prompt", async () => {
    const log = `${process.cwd()}/.tmp-queued-abort.log`;
    await writeFile(log, "");
    const bridge = new McodeAcpBridge({
      command: process.execPath,
      args: ["run", fixture],
    });
    process.env.FAKE_AGENT_LOG = log;
    try {
      const firstController = new AbortController();
      const first = bridge.prompt({
        sessionID: "opencode-queued",
        cwd: process.cwd(),
        prompt: "wait",
        signal: firstController.signal,
      });
      // Give the first call time to occupy the turn.
      await new Promise((resolve) => setTimeout(resolve, 800));
      const queuedController = new AbortController();
      const queued = bridge.prompt({
        sessionID: "opencode-queued",
        cwd: process.cwd(),
        prompt: "queued-never-runs",
        signal: queuedController.signal,
      });
      const start = performance.now();
      queuedController.abort(new Error("queued cancelled by test"));
      await assert.rejects(queued, /queued cancelled by test/);
      const elapsed = performance.now() - start;
      assert.ok(
        elapsed < 2000,
        `queued abort took ${elapsed}ms; it waited for the active turn`,
      );

      // The active turn must be unaffected; cancel it and recover.
      firstController.abort(new Error("first cancelled by test"));
      await assert.rejects(first, /first cancelled by test/);
      const recovery = await bridge.prompt({
        sessionID: "opencode-queued",
        cwd: process.cwd(),
        prompt: "after-cancel",
        signal: new AbortController().signal,
      });
      assert.match(recovery.output, /after-cancel/);
      const logged = await readFile(log, "utf8");
      assert.ok(
        !logged.includes("queued-never-runs"),
        `cancelled queued prompt reached the agent: ${logged}`,
      );
    } finally {
      delete process.env.FAKE_AGENT_LOG;
      await rm(log, { force: true }).catch(() => {});
    }
  });

  test("times out while queued, within the total budget", async () => {
    const bridge = new McodeAcpBridge({
      command: process.execPath,
      args: ["run", fixture],
    });
    const firstController = new AbortController();
    const first = bridge.prompt({
      sessionID: "opencode-queue-timeout",
      cwd: process.cwd(),
      prompt: "wait",
      signal: firstController.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 800));
    const start = performance.now();
    await assert.rejects(
      bridge.prompt({
        sessionID: "opencode-queue-timeout",
        cwd: process.cwd(),
        prompt: "queued work",
        signal: new AbortController().signal,
        timeoutMs: 500,
      }),
      /MCODE_TIMEOUT.*phase.+queued/s,
    );
    assert.ok(performance.now() - start < 5000);
    firstController.abort(new Error("cleanup"));
    await assert.rejects(first, /cleanup/);
  });

  test("times out during execution and stays usable", async () => {
    const bridge = new McodeAcpBridge({
      command: process.execPath,
      args: ["run", fixture],
    });
    await assert.rejects(
      bridge.prompt({
        sessionID: "opencode-exec-timeout",
        cwd: process.cwd(),
        prompt: "wait",
        signal: new AbortController().signal,
        timeoutMs: 500,
      }),
      /MCODE_TIMEOUT.*phase.+running/s,
    );
    const recovery = await bridge.prompt({
      sessionID: "opencode-exec-timeout",
      cwd: process.cwd(),
      prompt: "hello",
      signal: new AbortController().signal,
    });
    assert.match(recovery.output, /hello/);
  });

  test("denies permission when the handler rejects", async () => {
    const bridge = new McodeAcpBridge({
      command: process.execPath,
      args: ["run", fixture],
    });
    const result = await bridge.prompt({
      sessionID: "opencode-deny",
      cwd: process.cwd(),
      prompt: "need-permission",
      signal: new AbortController().signal,
      requestPermission: async () => ({
        outcome: { outcome: "selected", optionId: "deny" },
      }),
    });
    assert.equal(result.output, "denied");
  });

  test("aborts while a permission decision is pending", async () => {
    const bridge = new McodeAcpBridge({
      command: process.execPath,
      args: ["run", fixture],
    });
    const controller = new AbortController();
    let asked = false;
    const pending = bridge.prompt({
      sessionID: "opencode-perm-abort",
      cwd: process.cwd(),
      prompt: "need-permission",
      signal: controller.signal,
      requestPermission: async () => {
        asked = true;
        // Simulates context.ask(): not itself cancellable; resolves late.
        await new Promise((resolve) => setTimeout(resolve, 5000));
        return { outcome: { outcome: "selected", optionId: "allow" } };
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.ok(asked, "permission was never requested");
    controller.abort(new Error("perm aborted by test"));
    await assert.rejects(pending, /perm aborted by test/);
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
