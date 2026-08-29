import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { chmod, link, lstat, mkdir, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { TextDecoder } from "node:util";

import {
  type CommandResult,
  type ControlRequest,
  type ControlSnapshot,
  commandResultSchema,
  controlRequestSchema,
  controlSnapshotSchema,
} from "./control-protocol.js";

const maximumFrameBytes = 64 * 1_024;

export interface ControlProvider {
  handle(request: ControlRequest): Promise<CommandResult | ControlSnapshot>;
  snapshot(): ControlSnapshot;
  subscribe(subscriber: (snapshot: ControlSnapshot) => void): () => void;
}

export interface ControlServerController {
  close(): Promise<void>;
  path: string;
}

export interface ControlServerOptions {
  path: string;
  provider: ControlProvider;
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function inspect(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if (missing(error)) {
      return null;
    }
    throw error;
  }
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("Runtime directory must be a real directory");
  }
  await chmod(path, 0o700);
}

async function socketIsLive(path: string): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const socket = createConnection(path);
    let settled = false;
    const finish = (work: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      work();
    };
    socket.once("connect", () => finish(() => resolve(true)));
    socket.once("error", (error: NodeJS.ErrnoException) =>
      finish(() => {
        if (error.code === "ECONNREFUSED") {
          resolve(false);
        } else {
          reject(error);
        }
      }),
    );
  });
}

async function prepareSocketPath(path: string): Promise<void> {
  const original = await inspect(path);
  if (original === null) {
    return;
  }
  if (original.isSymbolicLink() || !original.isSocket()) {
    throw new Error("Control socket path must not collide with a symlink or non-socket");
  }
  if (await socketIsLive(path)) {
    throw new Error("Another Toggl Waybar daemon is already running");
  }
  const current = await inspect(path);
  if (current === null || !current.isSocket() || !sameIdentity(original, current)) {
    throw new Error("Control socket changed while checking stale state");
  }
  await unlink(path);
}

function writeFrame(socket: Socket, value: unknown): boolean {
  const frame = `${JSON.stringify(value)}\n`;
  return Buffer.byteLength(frame, "utf8") <= maximumFrameBytes && socket.write(frame, "utf8");
}

function serveConnection(socket: Socket, provider: ControlProvider): () => void {
  let accepted = false;
  let buffer = Buffer.alloc(0);
  let invalid = false;
  let unsubscribe: (() => void) | null = null;

  const reject = (): void => {
    invalid = true;
    unsubscribe?.();
    unsubscribe = null;
    socket.destroy();
  };

  const publish = (snapshot: ControlSnapshot): void => {
    let parsed: ControlSnapshot;
    try {
      parsed = controlSnapshotSchema.parse(snapshot);
    } catch {
      reject();
      return;
    }
    if (!writeFrame(socket, parsed)) {
      reject();
    }
  };

  const handle = async (request: ControlRequest): Promise<void> => {
    if (invalid || socket.destroyed) {
      return;
    }
    if (request.type === "watch") {
      unsubscribe = provider.subscribe(publish);
      publish(provider.snapshot());
      return;
    }
    try {
      const result = commandResultSchema.parse(await provider.handle(request));
      if (!invalid && !socket.destroyed) {
        socket.end(`${JSON.stringify(result)}\n`, "utf8");
      }
    } catch {
      if (!invalid && !socket.destroyed) {
        socket.end(
          `${JSON.stringify({ version: 1, type: "result", outcome: "failed", error: "request_failed" })}\n`,
          "utf8",
        );
      }
    }
  };

  socket.on("data", (chunk: Buffer) => {
    if (accepted || buffer.length + chunk.length > maximumFrameBytes) {
      reject();
      return;
    }
    buffer = Buffer.concat([buffer, chunk]);
    const newline = buffer.indexOf(0x0a);
    if (newline === -1) {
      return;
    }
    if (newline !== buffer.length - 1) {
      reject();
      return;
    }
    accepted = true;
    let request: ControlRequest;
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, newline));
      request = controlRequestSchema.parse(JSON.parse(text));
    } catch {
      reject();
      return;
    }
    setImmediate(() => void handle(request));
  });
  socket.on("end", () => {
    if (!accepted) {
      reject();
    }
  });
  const cleanup = (): void => {
    unsubscribe?.();
    unsubscribe = null;
  };
  socket.on("close", cleanup);
  return reject;
}

function listen(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(path);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

export async function startControlServer(
  options: ControlServerOptions,
): Promise<ControlServerController> {
  const directory = dirname(options.path);
  await ensurePrivateDirectory(directory);
  await prepareSocketPath(options.path);

  let accepting = true;
  const sockets = new Map<Socket, () => void>();
  const server = createServer((socket) => {
    if (!accepting) {
      socket.destroy();
      return;
    }
    const reject = serveConnection(socket, options.provider);
    sockets.set(socket, reject);
    socket.once("close", () => sockets.delete(socket));
  });
  const boundPath = `${options.path}.${process.pid}.${randomUUID()}.bound`;
  await listen(server, boundPath);

  let created: Stats;
  let bound: Stats | null = null;
  let published = false;
  try {
    await chmod(boundPath, 0o600);
    bound = await lstat(boundPath);
    await link(boundPath, options.path);
    published = true;
    created = await lstat(options.path);
    if (!created.isSocket() || !sameIdentity(bound, created)) {
      throw new Error("Control socket path is not a socket");
    }
    await unlink(boundPath);
  } catch (error) {
    for (const reject of sockets.values()) {
      reject();
    }
    if (published && bound !== null) {
      const current = await inspect(options.path);
      if (current !== null && sameIdentity(bound, current)) {
        await unlink(options.path);
      }
    }
    await closeServer(server).catch(() => undefined);
    await unlink(boundPath).catch(() => undefined);
    throw error;
  }

  let closing: Promise<void> | null = null;
  const close = (): Promise<void> => {
    if (closing !== null) {
      return closing;
    }
    accepting = false;
    const stopped = closeServer(server);
    for (const reject of sockets.values()) {
      reject();
    }
    closing = (async () => {
      const current = await inspect(options.path);
      if (current?.isSocket() && sameIdentity(created, current)) {
        await unlink(options.path);
      }
      await stopped;
    })();
    return closing;
  };

  return { close, path: options.path };
}
