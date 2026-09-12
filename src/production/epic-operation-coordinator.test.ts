// ---
// relationships:
//   implements: heddle
// ---

import { describe, expect, it } from "vitest";

import { EpicOperationCoordinator } from "./epic-operation-coordinator.js";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
};

describe("EpicOperationCoordinator", () => {
  it("serializes operations for one epic in arrival order", async () => {
    const subject = new EpicOperationCoordinator();
    const firstMayFinish = deferred();
    const firstEntered = deferred();
    const entered: string[] = [];

    const first = subject.run(10, async () => {
      entered.push("first");
      firstEntered.resolve();
      await firstMayFinish.promise;
      entered.push("first-finished");
    });
    const second = subject.run(10, async () => {
      entered.push("second");
    });

    await firstEntered.promise;
    expect(entered).toEqual(["first"]);
    firstMayFinish.resolve();
    await Promise.all([first, second]);
    expect(entered).toEqual(["first", "first-finished", "second"]);
  });

  it("allows different epics to proceed independently", async () => {
    const subject = new EpicOperationCoordinator();
    const firstMayFinish = deferred();
    const entered: number[] = [];

    const first = subject.run(10, async () => {
      entered.push(10);
      await firstMayFinish.promise;
    });
    const second = subject.run(11, async () => {
      entered.push(11);
    });

    await second;
    expect(entered).toEqual([10, 11]);
    firstMayFinish.resolve();
    await first;
  });

  it("releases the next operation after a failure", async () => {
    const subject = new EpicOperationCoordinator();
    const first = subject.run(10, () => Promise.reject(new Error("failed")));
    const second = subject.run(10, async () => "continued");

    await expect(first).rejects.toThrow("failed");
    await expect(second).resolves.toBe("continued");
  });
});
