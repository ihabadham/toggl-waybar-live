import { parseRelayMessage, type RelayMessage } from "@toggl-waybar-live/shared";
import WebSocket from "ws";

export type RelayStaleReason = "connect_failed" | "heartbeat_timeout" | "invalid_message";

export interface RelayClientCallbacks {
  onClose(): void;
  onMessage(message: RelayMessage): void;
  onOpen(): void;
  onStale(reason: RelayStaleReason): void;
}

interface RelaySocket {
  close(code?: number, reason?: string): void;
  on(event: "open", listener: () => void): this;
  on(event: "message", listener: (data: WebSocket.RawData) => void): this;
  on(event: "close", listener: () => void): this;
  on(event: "error", listener: () => void): this;
  send(data: string): void;
  terminate(): void;
}

export type RelaySocketFactory = (
  url: string,
  options: { headers: { Authorization: string } },
) => RelaySocket;

export interface RelayTimers {
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
  setTimeout(callback: () => void, milliseconds: number): ReturnType<typeof setTimeout>;
}

export interface RelayClientOptions extends RelayClientCallbacks {
  random?: () => number;
  socketFactory?: RelaySocketFactory;
  timers?: RelayTimers;
  token: string;
  url: string;
}

const heartbeatIntervalMilliseconds = 45_000;
const heartbeatTimeoutMilliseconds = 15_000;
const maximumBackoffMilliseconds = 60_000;

const systemTimers: RelayTimers = {
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: (handle) => clearTimeout(handle),
};

export class RelayClient {
  private attempt = 0;
  private heartbeatDeadline: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private socket: RelaySocket | null = null;
  private stopped = true;

  private readonly callbacks: RelayClientCallbacks;
  private readonly random: () => number;
  private readonly socketFactory: RelaySocketFactory;
  private readonly timers: RelayTimers;
  private readonly token: string;
  private readonly url: string;

  constructor(options: RelayClientOptions) {
    this.callbacks = {
      onClose: options.onClose,
      onMessage: options.onMessage,
      onOpen: options.onOpen,
      onStale: options.onStale,
    };
    this.random = options.random ?? Math.random;
    this.token = options.token;
    this.url = options.url;
    this.timers = options.timers ?? systemTimers;
    this.socketFactory =
      options.socketFactory ??
      ((url, configuration) => new WebSocket(url, configuration) as RelaySocket);
  }

  start(): void {
    if (!this.stopped) {
      return;
    }
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000, "shutdown");
  }

  private connect(): void {
    if (this.stopped) {
      return;
    }

    let socket: RelaySocket;
    try {
      socket = this.socketFactory(this.url, {
        headers: { Authorization: `Bearer ${this.token}` },
      });
    } catch {
      this.callbacks.onStale("connect_failed");
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.on("open", () => {
      if (socket !== this.socket || this.stopped) {
        return;
      }
      this.callbacks.onOpen();
      this.scheduleHeartbeat(socket);
    });
    socket.on("message", (data) => this.handleMessage(socket, data));
    socket.on("error", () => {
      if (socket === this.socket && !this.stopped) {
        this.callbacks.onStale("connect_failed");
      }
    });
    socket.on("close", () => {
      if (socket !== this.socket) {
        return;
      }
      this.socket = null;
      this.clearHeartbeatTimers();
      this.callbacks.onClose();
      this.scheduleReconnect();
    });
  }

  private handleMessage(socket: RelaySocket, data: WebSocket.RawData): void {
    if (socket !== this.socket || this.stopped) {
      return;
    }
    const text = data.toString();
    if (text === "pong") {
      if (this.heartbeatDeadline !== null) {
        this.timers.clearTimeout(this.heartbeatDeadline);
        this.heartbeatDeadline = null;
      }
      this.attempt = 0;
      return;
    }

    try {
      this.callbacks.onMessage(parseRelayMessage(JSON.parse(text)));
      this.attempt = 0;
    } catch {
      this.callbacks.onStale("invalid_message");
      socket.terminate();
    }
  }

  private scheduleHeartbeat(socket: RelaySocket): void {
    this.heartbeatTimer = this.timers.setTimeout(() => {
      if (socket !== this.socket || this.stopped) {
        return;
      }
      socket.send("ping");
      this.heartbeatDeadline = this.timers.setTimeout(() => {
        if (socket !== this.socket || this.stopped) {
          return;
        }
        this.callbacks.onStale("heartbeat_timeout");
        socket.terminate();
      }, heartbeatTimeoutMilliseconds);
      this.scheduleHeartbeat(socket);
    }, heartbeatIntervalMilliseconds);
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer !== null) {
      return;
    }
    const cap = Math.min(maximumBackoffMilliseconds, 1_000 * 2 ** this.attempt);
    this.attempt += 1;
    const delay = Math.floor(this.random() * cap);
    this.reconnectTimer = this.timers.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private clearHeartbeatTimers(): void {
    if (this.heartbeatTimer !== null) {
      this.timers.clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.heartbeatDeadline !== null) {
      this.timers.clearTimeout(this.heartbeatDeadline);
      this.heartbeatDeadline = null;
    }
  }

  private clearTimers(): void {
    this.clearHeartbeatTimers();
    if (this.reconnectTimer !== null) {
      this.timers.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
