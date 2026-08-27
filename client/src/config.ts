export interface ClientConfig {
  labelMaxChars: number;
  relayToken: string;
  relayUrl: string;
  timezone: string;
  togglApiToken: string;
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

function validTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}

function isLocalHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function relayUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("TOGGL_RELAY_URL must be a valid URL");
  }

  if (url.protocol !== "wss:" && !(url.protocol === "ws:" && isLocalHostname(url.hostname))) {
    throw new Error("TOGGL_RELAY_URL must use wss except on localhost");
  }
  return url.toString();
}

function labelLimit(value: string | undefined): number {
  if (value === undefined) {
    return 12;
  }
  if (!/^\d+$/.test(value)) {
    throw new Error("TOGGL_LABEL_MAX_CHARS must be a positive integer");
  }
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error("TOGGL_LABEL_MAX_CHARS must be a positive integer");
  }
  return limit;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): ClientConfig {
  const timezone = required(environment, "TOGGL_TIMEZONE");
  if (!validTimezone(timezone)) {
    throw new Error("TOGGL_TIMEZONE must be a valid IANA timezone");
  }

  return {
    togglApiToken: required(environment, "TOGGL_API_TOKEN"),
    timezone,
    relayUrl: relayUrl(required(environment, "TOGGL_RELAY_URL")),
    relayToken: required(environment, "TOGGL_RELAY_TOKEN"),
    labelMaxChars: labelLimit(environment.TOGGL_LABEL_MAX_CHARS),
  };
}
