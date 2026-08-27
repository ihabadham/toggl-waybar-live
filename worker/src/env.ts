import type { NormalizedEvent } from "@toggl-waybar-live/shared";
import type { RelayObject } from "./relay-object.js";

export interface WorkerEnv {
  RELAY: DurableObjectNamespace<RelayObject>;
  RELAY_TOKEN: string;
  TOGGL_USER_ID: string;
  TOGGL_WEBHOOK_SECRET: string;
}

export type ApplyEvent = (event: NormalizedEvent) => Promise<void>;
