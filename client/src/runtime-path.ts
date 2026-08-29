import { join } from "node:path";

export interface RuntimePaths {
  controlSocket: string;
  directory: string;
  stateFile: string;
}

export function runtimePaths(environment: NodeJS.ProcessEnv = process.env): RuntimePaths {
  const runtimeRoot = environment.XDG_RUNTIME_DIR;
  if (!runtimeRoot) {
    throw new Error("XDG_RUNTIME_DIR is required");
  }
  const directory = join(runtimeRoot, "toggl-waybar-live");
  return {
    directory,
    stateFile: join(directory, "state.json"),
    controlSocket: join(directory, "control.sock"),
  };
}
