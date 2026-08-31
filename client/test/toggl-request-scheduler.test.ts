import { describe, expect, it, vi } from "vitest";

import { TogglRequestScheduler } from "../src/toggl-request-scheduler.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
}

class FakeMonotonicClock {
  now = 0;
  readonly waits: Array<{ milliseconds: number; resolve(): void }> = [];

  readonly monotonicNow = (): number => this.now;

  readonly wait = vi.fn(
    (milliseconds: number) =>
      new Promise<void>((resolve) => {
        this.waits.push({ milliseconds, resolve });
      }),
  );

  async releaseNextWait(): Promise<void> {
    const pending = this.waits.shift();
    if (pending === undefined) {
      throw new Error("No scheduler wait is pending");
    }
    this.now += pending.milliseconds;
    pending.resolve();
    await flushMicrotasks();
  }
}

function schedulerWith(clock: FakeMonotonicClock): TogglRequestScheduler {
  return new TogglRequestScheduler({
    minimumStartIntervalMilliseconds: 1_000,
    monotonicNow: clock.monotonicNow,
    wait: clock.wait,
  });
}

describe("Toggl request scheduler", () => {
  it("runs at most one request at a time", async () => {
    const clock = new FakeMonotonicClock();
    const scheduler = schedulerWith(clock);
    const firstGate = deferred<void>();
    const secondGate = deferred<void>();
    const thirdGate = deferred<void>();
    let active = 0;
    let maximumActive = 0;
    const starts: string[] = [];
    const operation = (name: string, gate: Deferred<void>) => async () => {
      starts.push(name);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await gate.promise;
      active -= 1;
    };

    const first = scheduler.runControl(operation("first", firstGate));
    const second = scheduler.runControl(operation("second", secondGate));
    const third = scheduler.runBackground(operation("third", thirdGate), () => true);
    await flushMicrotasks();

    expect(starts).toEqual(["first"]);
    expect(active).toBe(1);

    firstGate.resolve();
    await flushMicrotasks();
    expect(starts).toEqual(["first"]);
    await clock.releaseNextWait();
    expect(starts).toEqual(["first", "second"]);

    secondGate.resolve();
    await flushMicrotasks();
    await clock.releaseNextWait();
    expect(starts).toEqual(["first", "second", "third"]);

    thirdGate.resolve();
    await Promise.all([first, second, third, scheduler.drain()]);
    expect(maximumActive).toBe(1);
  });

  it("keeps 1,000 millisecond start gaps and FIFO order within each priority", async () => {
    const clock = new FakeMonotonicClock();
    const scheduler = schedulerWith(clock);
    const starts: Array<{ name: string; at: number }> = [];
    const operation = (name: string) => async () => {
      starts.push({ name, at: clock.now });
    };

    const backgroundOne = scheduler.runBackground(operation("background-1"), () => true);
    const controlOne = scheduler.runControl(operation("control-1"));
    const backgroundTwo = scheduler.runBackground(operation("background-2"), () => true);
    const controlTwo = scheduler.runControl(operation("control-2"));
    await flushMicrotasks();

    expect(starts).toEqual([{ name: "control-1", at: 0 }]);
    await clock.releaseNextWait();
    expect(starts).toEqual([
      { name: "control-1", at: 0 },
      { name: "control-2", at: 1_000 },
    ]);
    await clock.releaseNextWait();
    await clock.releaseNextWait();
    await Promise.all([backgroundOne, controlOne, backgroundTwo, controlTwo, scheduler.drain()]);

    expect(starts).toEqual([
      { name: "control-1", at: 0 },
      { name: "control-2", at: 1_000 },
      { name: "background-1", at: 2_000 },
      { name: "background-2", at: 3_000 },
    ]);
    expect(starts.slice(1).map((start, index) => start.at - (starts[index]?.at ?? 0))).toEqual([
      1_000, 1_000, 1_000,
    ]);
  });

  it("starts a control queued during pacing before the waiting background", async () => {
    const clock = new FakeMonotonicClock();
    const scheduler = schedulerWith(clock);
    const starts: string[] = [];
    const operation = (name: string) => async () => {
      starts.push(name);
    };

    const first = scheduler.runBackground(operation("background-1"), () => true);
    const second = scheduler.runBackground(operation("background-2"), () => true);
    await flushMicrotasks();
    expect(starts).toEqual(["background-1"]);
    expect(clock.waits).toHaveLength(1);

    const control = scheduler.runControl(operation("control"));
    await flushMicrotasks();
    expect(starts).toEqual(["background-1"]);

    await clock.releaseNextWait();
    expect(starts).toEqual(["background-1", "control"]);
    await clock.releaseNextWait();
    await Promise.all([first, second, control, scheduler.drain()]);
    expect(starts).toEqual(["background-1", "control", "background-2"]);
  });

  it("skips an obsolete background request without invoking its callback", async () => {
    const clock = new FakeMonotonicClock();
    const scheduler = schedulerWith(clock);
    const operation = vi.fn(async () => "unused");
    const stillRelevant = vi.fn(() => false);

    await expect(scheduler.runBackground(operation, stillRelevant)).resolves.toEqual({
      status: "skipped",
    });
    await scheduler.drain();

    expect(stillRelevant).toHaveBeenCalledOnce();
    expect(operation).not.toHaveBeenCalled();
    expect(clock.wait).not.toHaveBeenCalled();
  });

  it("never cancels an active background or control request", async () => {
    const clock = new FakeMonotonicClock();
    const scheduler = schedulerWith(clock);
    const backgroundGate = deferred<string>();
    const controlGate = deferred<string>();
    const starts: string[] = [];

    const background = scheduler.runBackground(
      async () => {
        starts.push("background-active");
        return backgroundGate.promise;
      },
      () => true,
    );
    await flushMicrotasks();

    const control = scheduler.runControl(async () => {
      starts.push("control-active");
      return controlGate.promise;
    });
    await flushMicrotasks();
    expect(starts).toEqual(["background-active"]);

    backgroundGate.resolve("background-finished");
    await flushMicrotasks();
    await clock.releaseNextWait();
    expect(starts).toEqual(["background-active", "control-active"]);
    await expect(background).resolves.toEqual({
      status: "completed",
      value: "background-finished",
    });

    const queuedBackground = scheduler.runBackground(
      async () => {
        starts.push("background-queued");
        return "queued-finished";
      },
      () => true,
    );
    await flushMicrotasks();
    expect(starts).toEqual(["background-active", "control-active"]);

    controlGate.resolve("control-finished");
    await flushMicrotasks();
    await clock.releaseNextWait();
    await expect(control).resolves.toBe("control-finished");
    await expect(queuedBackground).resolves.toEqual({
      status: "completed",
      value: "queued-finished",
    });
    await scheduler.drain();
    expect(starts).toEqual(["background-active", "control-active", "background-queued"]);
  });

  it("drain waits for the active request, pacing, and every queued request", async () => {
    const clock = new FakeMonotonicClock();
    const scheduler = schedulerWith(clock);
    const firstGate = deferred<void>();
    const secondGate = deferred<void>();
    const starts: string[] = [];
    let drained = false;

    const first = scheduler.runControl(async () => {
      starts.push("first");
      await firstGate.promise;
    });
    const second = scheduler.runBackground(
      async () => {
        starts.push("second");
        await secondGate.promise;
      },
      () => true,
    );
    const draining = scheduler.drain().then(() => {
      drained = true;
    });
    await flushMicrotasks();

    expect(starts).toEqual(["first"]);
    expect(drained).toBe(false);

    firstGate.resolve();
    await flushMicrotasks();
    expect(clock.waits).toHaveLength(1);
    expect(drained).toBe(false);

    await clock.releaseNextWait();
    expect(starts).toEqual(["first", "second"]);
    expect(drained).toBe(false);

    secondGate.resolve();
    await Promise.all([first, second, draining]);
    expect(drained).toBe(true);
  });
});
