import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { test } from "bun:test";
import { fileURLToPath } from "node:url";
import { isAlive, terminateProcessTree } from "../src/process.js";

const family = fileURLToPath(
  new URL("./fixtures/spawn-family.ts", import.meta.url),
);

function pidsOf(pid: number): number[] {
  try {
    const out = execFileSync("ps", ["-o", "pid=", "--ppid", String(pid)], {
      encoding: "utf8",
    });
    return out
      .split(/\s+/)
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    return [];
  }
}

test("terminateProcessTree escalates and reaps a SIGTERM-ignoring tree", async () => {
  const pidFile = `/tmp/spawn-family-${process.pid}.pids`;
  const child = spawn(process.execPath, ["run", family, pidFile], {
    stdio: "ignore",
    detached: true,
  });
  assert.ok(child.pid);
  let parent = -1;
  let descendant = -1;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const text = await readFile(pidFile, "utf8");
      const [p, d] = text.trim().split(/\s+/).map(Number);
      if (Number.isInteger(p) && Number.isInteger(d) && p > 0 && d > 0) {
        parent = p;
        descendant = d;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(parent > 0 && descendant > 0, "fixture never reported pids");
  assert.ok(isAlive(parent) && isAlive(descendant));

  const result = await terminateProcessTree(child as ChildProcess, {
    graceMs: 500,
  });

  assert.equal(result.exited, true);
  assert.equal(result.forced, true);
  assert.ok(!isAlive(parent), "family parent survived termination");
  assert.ok(!isAlive(descendant), "descendant survived termination");
  assert.deepEqual(pidsOf(parent), []);
  await rm(pidFile, { force: true });
});

test("terminateProcessTree exits gracefully without force", async () => {
  const child = spawn("sleep", ["60"], { detached: true });
  assert.ok(child.pid);
  const result = await terminateProcessTree(child, { graceMs: 2000 });
  assert.equal(result.exited, true);
  assert.equal(result.forced, false);
  assert.ok(!isAlive(child.pid!));
});
