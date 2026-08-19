import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

import { describe, expect, it } from "vitest";

import { terminateChildProcess } from "./bounded-process-termination";

function fakeChild(pid: number): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, {
    pid,
    killed: false,
    exitCode: null,
  });
  return child;
}

describe("terminateChildProcess", () => {
  it("does not force kill a child that closes during grace", async () => {
    const child = fakeChild(101);
    const signals: NodeJS.Signals[] = [];
    const pending = terminateChildProcess(child, {
      timeoutMs: 20,
      sendSignal: (_pid, signal) => {
        signals.push(signal);
      },
    });

    child.emit("close", 0);
    await pending;

    expect(signals).toEqual(["SIGTERM"]);
  });

  it("force kills and resolves when a child ignores SIGTERM", async () => {
    const child = fakeChild(102);
    const signals: NodeJS.Signals[] = [];

    await terminateChildProcess(child, {
      timeoutMs: 10,
      sendSignal: (_pid, signal) => {
        signals.push(signal);
      },
    });

    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });
});
