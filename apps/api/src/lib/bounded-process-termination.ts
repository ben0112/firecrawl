import { type ChildProcess, spawn } from "node:child_process";

export interface TerminateChildProcessOptions {
  timeoutMs?: number;
  platform?: NodeJS.Platform;
  sendSignal?: (pid: number, signal: NodeJS.Signals) => void;
  onForce?: (pid: number) => void;
}

function defaultSendSignal(
  child: ChildProcess,
  platform: NodeJS.Platform,
  pid: number,
  signal: NodeJS.Signals,
): void {
  if (platform === "win32") {
    const killer = spawn(
      "taskkill",
      ["/pid", pid.toString(), "/t", ...(signal === "SIGKILL" ? ["/f"] : [])],
      { stdio: "ignore" },
    );
    killer.unref();
    return;
  }

  try {
    process.kill(-pid, signal);
  } catch {
    child.kill(signal);
  }
}

export function terminateChildProcess(
  child: ChildProcess,
  options: TerminateChildProcessOptions = {},
): Promise<void> {
  if (!child || child.killed || child.exitCode !== null || !child.pid) {
    return Promise.resolve();
  }

  const pid = child.pid;
  const timeoutMs = Math.max(1, Number(options.timeoutMs ?? 30_000));
  const platform = options.platform ?? process.platform;
  const sendSignal =
    options.sendSignal ??
    ((targetPid: number, signal: NodeJS.Signals) =>
      defaultSendSignal(child, platform, targetPid, signal));

  return new Promise(resolve => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;

    const cleanup = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.off("close", cleanup);
      child.off("error", cleanup);
      resolve();
    };

    child.once("close", cleanup);
    child.once("error", cleanup);

    try {
      sendSignal(pid, "SIGTERM");
    } catch {
      try {
        child.kill("SIGTERM");
      } catch {}
    }

    timer = setTimeout(() => {
      if (settled) return;
      options.onForce?.(pid);
      try {
        sendSignal(pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {}
      }
      cleanup();
    }, timeoutMs);
  });
}
