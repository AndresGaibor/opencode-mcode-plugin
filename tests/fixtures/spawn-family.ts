import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

// Test executor: ignores SIGTERM so termination must escalate, and leaves a
// descendant (sleep) that must also be reaped. Writes "parentPid childPid".
process.on("SIGTERM", () => {});

const target = process.argv[2] ?? "/tmp/spawn-family.pids";
const sleeper = spawn("sleep", ["60"], { stdio: "ignore" });
writeFileSync(target, `${process.pid} ${sleeper.pid ?? -1}\n`);
setInterval(() => {}, 60_000);
