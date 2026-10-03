import { execFile, type ChildProcess } from "node:child_process";

export type TerminateResult = {
  /** True only when the process (and its group) was observed to exit. */
  exited: boolean;
  /** True when escalation to SIGKILL / force-kill was required. */
  forced: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
};

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    // EPERM means the process exists but we may not signal it.
    return code === "EPERM";
  }
}

/** Resolves true when the child exits within timeoutMs, false on timeout. */
export function waitForExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      child.removeListener("exit", onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}

function signalTree(
  child: ChildProcess,
  signal: NodeJS.Signals,
): { group: boolean } {
  const pid = child.pid;
  if (pid === undefined) return { group: false };
  if (process.platform !== "win32") {
    try {
      // Negative pid targets the process group started with detached: true.
      // Only the group this plugin created is signalled, never arbitrary pids.
      process.kill(-pid, signal);
      return { group: true };
    } catch {
      // Not a group leader (or already gone); fall through to the child.
    }
  }
  try {
    child.kill(signal);
    return { group: false };
  } catch {
    return { group: false };
  }
}

function taskkillTree(pid: number): Promise<void> {
  return new Promise<void>((resolve) => {
    execFile("taskkill", ["/pid", String(pid), "/T", "/F"], () => resolve());
  });
}

/**
 * Terminates an ACP executor process and its descendants, with evidence.
 *
 * Order: SIGTERM to the process group (POSIX) or the child (Windows), wait
 * `graceMs`, then escalate to SIGKILL / `taskkill /F /T`. The returned
 * `exited` flag reports whether the process was actually observed to exit;
 * a signal being sent is never treated as proof of termination.
 *
 * Callers must spawn the child with `detached: true` on POSIX so the group
 * signal only reaches processes this plugin started.
 */
export async function terminateProcessTree(
  child: ChildProcess,
  options: { graceMs?: number } = {},
): Promise<TerminateResult> {
  const graceMs = options.graceMs ?? 2000;
  if (child.exitCode !== null || child.signalCode !== null) {
    return {
      exited: true,
      forced: false,
      code: child.exitCode,
      signal: child.signalCode,
    };
  }

  signalTree(child, "SIGTERM");
  if (await waitForExit(child, graceMs)) {
    return {
      exited: true,
      forced: false,
      code: child.exitCode,
      signal: child.signalCode,
    };
  }

  if (process.platform === "win32" && child.pid !== undefined) {
    await taskkillTree(child.pid);
  } else {
    signalTree(child, "SIGKILL");
  }
  const exited = await waitForExit(child, graceMs);
  return {
    exited,
    forced: true,
    code: child.exitCode,
    signal: child.signalCode,
  };
}
