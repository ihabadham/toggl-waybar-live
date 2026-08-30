import { randomUUID } from "node:crypto";

import type { ProjectColor } from "./project-color.js";

export const maximumPresets = 8;

export interface ResumeActivity {
  billable: boolean;
  description: string;
  projectId: string | null;
  tagIds: string[];
  tags: string[];
  taskId: string | null;
  workspaceId: string;
}

export interface ResumePreset extends ResumeActivity {
  id: string;
  lastUsedAt: string;
  projectColor: ProjectColor | null;
  projectName: string | null;
  taskName: string | null;
}

export interface PresetUpdate {
  activity: ResumeActivity & Pick<ResumePreset, "projectColor" | "projectName" | "taskName">;
  lastUsedAt: string;
}

export type Activity = ResumeActivity;
export type Preset = ResumePreset;

function canonicalValues(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function canonicalActivity(activity: ResumeActivity): ResumeActivity {
  return {
    workspaceId: activity.workspaceId,
    description: activity.description,
    projectId: activity.projectId,
    taskId: activity.taskId,
    tagIds: canonicalValues(activity.tagIds),
    tags: canonicalValues(activity.tags),
    billable: activity.billable,
  };
}

function timestampValue(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function compareNewest(left: ResumePreset, right: ResumePreset): number {
  const timestampDifference = timestampValue(right.lastUsedAt) - timestampValue(left.lastUsedAt);
  if (timestampDifference !== 0) {
    return timestampDifference;
  }
  if (left.id < right.id) {
    return -1;
  }
  return left.id > right.id ? 1 : 0;
}

export function presetIdentity(activity: ResumeActivity): string {
  const canonical = canonicalActivity(activity);
  return JSON.stringify([
    canonical.workspaceId,
    canonical.description,
    canonical.projectId,
    canonical.taskId,
    canonical.tagIds,
    canonical.tags,
    canonical.billable,
  ]);
}

export function activityFromPreset(preset: ResumePreset): ResumeActivity {
  const {
    id: _id,
    lastUsedAt: _lastUsedAt,
    projectColor: _projectColor,
    projectName: _projectName,
    taskName: _taskName,
    ...activity
  } = preset;
  return canonicalActivity(activity);
}

function canonicalPreset(preset: ResumePreset): ResumePreset {
  return { ...preset, ...canonicalActivity(preset) };
}

export function mergePresets(...presetLists: Array<readonly ResumePreset[]>): ResumePreset[] {
  const byIdentity = new Map<string, ResumePreset>();
  for (const preset of presetLists.flat()) {
    const canonical = canonicalPreset(preset);
    const identity = presetIdentity(canonical);
    const current = byIdentity.get(identity);
    if (!current || compareNewest(canonical, current) < 0) {
      byIdentity.set(identity, canonical);
    }
  }
  return [...byIdentity.values()].sort(compareNewest).slice(0, maximumPresets);
}

export function upsertPreset(
  presets: readonly ResumePreset[],
  activity: ResumeActivity & Pick<ResumePreset, "projectColor" | "projectName" | "taskName">,
  lastUsedAt: string,
  createId: () => string = randomUUID,
): ResumePreset[] {
  return upsertPresets(presets, [{ activity, lastUsedAt }], createId);
}

export function upsertPresets(
  presets: readonly ResumePreset[],
  updates: readonly PresetUpdate[],
  createId: () => string = randomUUID,
): ResumePreset[] {
  const existingByIdentity = new Map<string, ResumePreset>();
  for (const preset of presets.map(canonicalPreset)) {
    const identity = presetIdentity(preset);
    const existing = existingByIdentity.get(identity);
    if (!existing || compareNewest(preset, existing) < 0) {
      existingByIdentity.set(identity, preset);
    }
  }

  const replacements = new Map<string, ResumePreset>();
  for (const update of updates) {
    const canonical = canonicalActivity(update.activity);
    const identity = presetIdentity(canonical);
    const previous = replacements.get(identity);
    const replacement: ResumePreset = {
      ...canonical,
      id: existingByIdentity.get(identity)?.id ?? previous?.id ?? createId(),
      lastUsedAt: update.lastUsedAt,
      projectColor: update.activity.projectColor,
      projectName: update.activity.projectName,
      taskName: update.activity.taskName,
    };
    if (!previous || compareNewest(replacement, previous) < 0) {
      replacements.set(identity, replacement);
    }
  }

  return mergePresets(
    [...replacements.values()],
    [...existingByIdentity.entries()]
      .filter(([identity]) => !replacements.has(identity))
      .map(([, preset]) => preset),
  );
}
