import { createConnection, type Socket } from "node:net";
import { TextDecoder } from "node:util";

import {
  type CommandResult,
  type ControlErrorCode,
  type ControlRequest,
  type ControlSnapshot,
  commandResultSchema,
  controlSnapshotSchema,
} from "./control-protocol.js";
import { runtimePaths } from "./runtime-path.js";

const maximumFrameBytes = 64 * 1_024;
const commandTimeoutMilliseconds = 2_000;
const maximumReconnectDelayMilliseconds = 5_000;

type CommandRequest = Exclude<ControlRequest, { type: "watch" }>;

export class ControlClientError extends Error {
  constructor(
    message: string,
    readonly code: ControlErrorCode = "request_failed",
  ) {
    super(message);
  }
}

export interface CommandClientOptions {
  path?: string;
  timeoutMilliseconds?: number;
}

export interface WatchClientOptions {
  now?: () => Date;
  path?: string;
  reconnectDelay?: (attempt: number) => number;
}

export interface WatchController {
  done: Promise<void>;
  stop(): void;
}

function unavailableSnapshot(now: Date): ControlSnapshot {
  return {
    version: 1,
    type: "snapshot",
    status: "offline",
    connection: "offline",
    confidence: "uncertain",
    pending: null,
    current: null,
    completedTodaySeconds: 0,
    currentContributesToToday: false,
    presets: [],
    generatedAt: now.toISOString(),
    lastSynchronizedAt: null,
    error: "daemon_unavailable",
  };
}

export function sendControlCommand(
  request: CommandRequest,
  options: CommandClientOptions = {},
): Promise<CommandResult> {
  const path = options.path ?? runtimePaths().controlSocket;
  const timeoutMilliseconds = options.timeoutMilliseconds ?? commandTimeoutMilliseconds;
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let buffer = Buffer.alloc(0);
    let settled = false;
    const finish = (error: Error | null, result?: CommandResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      if (error) {
        reject(error);
      } else if (result) {
        resolve(result);
      }
    };
    const timeout = setTimeout(
      () => finish(new ControlClientError("The Toggl daemon did not respond")),
      timeoutMilliseconds,
    );
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`, "utf8"));
    socket.on("data", (chunk: Buffer) => {
      if (buffer.length + chunk.length > maximumFrameBytes) {
        finish(new ControlClientError("The Toggl daemon sent an oversized response"));
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      const unavailable = error.code === "ENOENT" || error.code === "ECONNREFUSED";
      finish(
        new ControlClientError(
          unavailable ? "The Toggl daemon is unavailable" : "The Toggl daemon request failed",
          unavailable ? "daemon_unavailable" : "request_failed",
        ),
      );
    });
    socket.once("end", () => {
      if (settled) {
        return;
      }
      const newline = buffer.indexOf(0x0a);
      if (newline === -1) {
        finish(new ControlClientError("The Toggl daemon closed without a response"));
        return;
      }
      if (newline !== buffer.length - 1) {
        finish(new ControlClientError("The Toggl daemon sent multiple responses"));
        return;
      }
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, newline));
        finish(null, commandResultSchema.parse(JSON.parse(text)));
      } catch {
        finish(new ControlClientError("The Toggl daemon sent an invalid response"));
      }
    });
  });
}

export function watchControlSnapshots(
  onSnapshot: (snapshot: ControlSnapshot) => void,
  options: WatchClientOptions = {},
): WatchController {
  const path = options.path ?? runtimePaths().controlSocket;
  const now = options.now ?? (() => new Date());
  const reconnectDelay =
    options.reconnectDelay ??
    ((attempt: number) => Math.min(maximumReconnectDelayMilliseconds, 250 * 2 ** attempt));
  let attempt = 0;
  let unavailableEmitted = false;
  let stopped = false;
  let socket: Socket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let finish: (() => void) | undefined;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });

  const disconnected = (): void => {
    if (stopped || reconnectTimer !== null) {
      return;
    }
    socket = null;
    if (!unavailableEmitted) {
      unavailableEmitted = true;
      onSnapshot(unavailableSnapshot(now()));
    }
    const delay = Math.max(0, Math.min(maximumReconnectDelayMilliseconds, reconnectDelay(attempt)));
    attempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  };

  const connect = (): void => {
    if (stopped) {
      return;
    }
    const candidate = createConnection(path);
    socket = candidate;
    let buffer = Buffer.alloc(0);
    let disconnectedOnce = false;
    const disconnect = (): void => {
      if (disconnectedOnce) {
        return;
      }
      disconnectedOnce = true;
      candidate.destroy();
      if (candidate === socket) {
        disconnected();
      }
    };
    candidate.once("connect", () =>
      candidate.write(`${JSON.stringify({ version: 1, type: "watch" })}\n`, "utf8"),
    );
    candidate.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (true) {
        const newline = buffer.indexOf(0x0a);
        if (newline === -1) {
          if (buffer.length > maximumFrameBytes) {
            disconnect();
          }
          return;
        }
        if (newline + 1 > maximumFrameBytes) {
          disconnect();
          return;
        }
        const frame = buffer.subarray(0, newline);
        buffer = buffer.subarray(newline + 1);
        try {
          const text = new TextDecoder("utf-8", { fatal: true }).decode(frame);
          const snapshot = controlSnapshotSchema.parse(JSON.parse(text));
          attempt = 0;
          unavailableEmitted = false;
          onSnapshot(snapshot);
        } catch {
          disconnect();
          return;
        }
      }
    });
    candidate.once("error", disconnect);
    candidate.once("close", disconnect);
  };

  connect();
  return {
    done,
    stop: () => {
      if (stopped) {
        return;
      }
      stopped = true;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      socket?.destroy();
      socket = null;
      finish?.();
    },
  };
}
