export type BackgroundRequestResult<T> = { status: "completed"; value: T } | { status: "skipped" };

export interface CoordinatorRequestScheduler {
  runControl<T>(operation: () => Promise<T>): Promise<T>;
  runBackground<T>(
    operation: () => Promise<T>,
    stillRelevant: () => boolean,
  ): Promise<BackgroundRequestResult<T>>;
  drain(): Promise<void>;
}

export interface TogglRequestSchedulerOptions {
  minimumStartIntervalMilliseconds?: number;
  monotonicNow?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
}

interface QueuedOperation {
  kind: "background" | "control";
  execute(): Promise<void>;
  reject(error: unknown): void;
  skip(): void;
  stillRelevant(): boolean;
}

const defaultMinimumStartIntervalMilliseconds = 1_000;

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class TogglRequestScheduler implements CoordinatorRequestScheduler {
  private readonly backgroundQueue: QueuedOperation[] = [];
  private readonly controlQueue: QueuedOperation[] = [];
  private lastStartedAt: number | null = null;
  private readonly minimumStartIntervalMilliseconds: number;
  private readonly monotonicNow: () => number;
  private pump: Promise<void> | null = null;
  private readonly wait: (milliseconds: number) => Promise<void>;

  constructor(options: TogglRequestSchedulerOptions = {}) {
    this.minimumStartIntervalMilliseconds =
      options.minimumStartIntervalMilliseconds ?? defaultMinimumStartIntervalMilliseconds;
    if (
      !Number.isFinite(this.minimumStartIntervalMilliseconds) ||
      this.minimumStartIntervalMilliseconds < 0
    ) {
      throw new Error("minimumStartIntervalMilliseconds must be a finite non-negative number");
    }
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.wait = options.wait ?? wait;
  }

  runControl<T>(operation: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.controlQueue.push({
        kind: "control",
        execute: async () => {
          try {
            resolve(await operation());
          } catch (error) {
            reject(error);
          }
        },
        reject,
        skip: () => undefined,
        stillRelevant: () => true,
      });
      this.startPump();
    });
  }

  runBackground<T>(
    operation: () => Promise<T>,
    stillRelevant: () => boolean,
  ): Promise<BackgroundRequestResult<T>> {
    return new Promise<BackgroundRequestResult<T>>((resolve, reject) => {
      this.backgroundQueue.push({
        kind: "background",
        execute: async () => {
          try {
            resolve({ status: "completed", value: await operation() });
          } catch (error) {
            reject(error);
          }
        },
        reject,
        skip: () => resolve({ status: "skipped" }),
        stillRelevant,
      });
      this.startPump();
    });
  }

  async drain(): Promise<void> {
    while (this.pump !== null) {
      await this.pump;
      await Promise.resolve();
    }
  }

  private startPump(): void {
    if (this.pump !== null) {
      return;
    }
    const running = Promise.resolve().then(() => this.runQueue());
    this.pump = running;
    void running.then(() => {
      if (this.pump !== running) {
        return;
      }
      this.pump = null;
      if (this.controlQueue.length > 0 || this.backgroundQueue.length > 0) {
        this.startPump();
      }
    });
  }

  private async runQueue(): Promise<void> {
    while (this.controlQueue.length > 0 || this.backgroundQueue.length > 0) {
      try {
        await this.waitForStartWindow();
      } catch (error) {
        this.rejectQueued(error);
        return;
      }

      const operation = this.controlQueue.shift() ?? this.backgroundQueue.shift();
      if (operation === undefined) {
        return;
      }
      if (operation.kind === "background") {
        let relevant: boolean;
        try {
          relevant = operation.stillRelevant();
        } catch (error) {
          operation.reject(error);
          continue;
        }
        if (!relevant) {
          operation.skip();
          continue;
        }
      }

      this.lastStartedAt = this.monotonicNow();
      await operation.execute();
    }
  }

  private async waitForStartWindow(): Promise<void> {
    while (this.lastStartedAt !== null) {
      const remaining =
        this.lastStartedAt + this.minimumStartIntervalMilliseconds - this.monotonicNow();
      if (remaining <= 0) {
        return;
      }
      await this.wait(remaining);
    }
  }

  private rejectQueued(error: unknown): void {
    for (const operation of [...this.controlQueue, ...this.backgroundQueue]) {
      operation.reject(error);
    }
    this.controlQueue.length = 0;
    this.backgroundQueue.length = 0;
  }
}
