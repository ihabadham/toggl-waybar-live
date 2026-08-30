import { describe, expect, it } from "vitest";

import {
  maximumPresets,
  mergePresets,
  presetIdentity,
  type ResumePreset,
  upsertPreset,
} from "../src/presets.js";

function preset(overrides: Partial<ResumePreset> = {}): ResumePreset {
  return {
    id: "0182cc10-54d1-7c35-b4f3-e93bb4c0b100",
    workspaceId: "202",
    description: "Review",
    projectId: "404",
    taskId: "505",
    tagIds: ["607", "606"],
    tags: ["urgent", "client"],
    billable: true,
    projectColor: "#c9806b",
    projectName: "Internal",
    taskName: "Write tests",
    lastUsedAt: "2026-08-27T10:00:00Z",
    ...overrides,
  };
}

describe("resume presets", () => {
  it("identifies activities independently of tag order and duplicates", () => {
    const original = preset();
    const reordered = preset({
      tagIds: ["606", "607", "606"],
      tags: ["client", "urgent", "client"],
    });
    const differentTags = preset({ tags: ["client"] });

    expect(presetIdentity(original)).toBe(presetIdentity(reordered));
    expect(presetIdentity(original)).not.toBe(presetIdentity(differentTags));
  });

  it("preserves an activity UUID while refreshing display metadata and moving it to the MRU front", () => {
    const original = preset({ lastUsedAt: "2026-08-27T10:00:00Z" });
    const other = preset({
      id: "0182cc10-54d1-7c35-b4f3-e93bb4c0b101",
      description: "Plan",
      lastUsedAt: "2026-08-27T11:00:00Z",
    });

    const merged = upsertPreset(
      [other, original],
      {
        ...original,
        tagIds: ["606", "607", "606"],
        tags: ["client", "urgent", "client"],
        projectColor: "#aabbcc",
        projectName: "Renamed project",
        taskName: "Renamed task",
      },
      "2026-08-27T12:00:00Z",
      () => "0182cc10-54d1-7c35-b4f3-e93bb4c0b102",
    );

    expect(merged).toMatchObject([
      {
        id: original.id,
        projectColor: "#aabbcc",
        projectName: "Renamed project",
        taskName: "Renamed task",
        tagIds: ["606", "607"],
        tags: ["client", "urgent"],
      },
      { id: other.id },
    ]);

    expect(
      upsertPreset(
        [],
        original,
        "2026-08-27T12:00:00Z",
        () => "0182cc10-54d1-7c35-b4f3-e93bb4c0b102",
      ),
    ).toMatchObject([{ id: "0182cc10-54d1-7c35-b4f3-e93bb4c0b102" }]);
  });

  it("merges unordered inputs by MRU time, uses stable UUID ties, and caps the list", () => {
    const presets = Array.from({ length: maximumPresets + 2 }, (_, index) =>
      preset({
        id: `0182cc10-54d1-7c35-b4f3-e93bb4c0b1${String(index).padStart(2, "0")}`,
        description: `Activity ${index}`,
        lastUsedAt: `2026-08-27T${String(10 + index).padStart(2, "0")}:00:00Z`,
      }),
    );
    const tiedFirst = preset({
      id: "0182cc10-54d1-7c35-b4f3-e93bb4c0b200",
      description: "Tie one",
      lastUsedAt: "2026-08-28T00:00:00Z",
    });
    const tiedSecond = preset({
      id: "0182cc10-54d1-7c35-b4f3-e93bb4c0b199",
      description: "Tie two",
      lastUsedAt: "2026-08-28T00:00:00Z",
    });

    const merged = mergePresets([...presets].reverse(), [tiedFirst, tiedSecond]);

    expect(merged).toHaveLength(maximumPresets);
    expect(merged.slice(0, 2).map(({ id }) => id)).toEqual([tiedSecond.id, tiedFirst.id]);
    expect(merged.map(({ lastUsedAt }) => lastUsedAt)).toEqual(
      [...merged]
        .map(({ lastUsedAt }) => lastUsedAt)
        .sort((left, right) => Date.parse(right) - Date.parse(left)),
    );
  });

  it("preserves the UUID of a matching preset even when it falls below the MRU cap", () => {
    const matching = preset({
      id: "0182cc10-54d1-7c35-b4f3-e93bb4c0b111",
      lastUsedAt: "2026-08-27T10:00:00Z",
    });
    const newer = Array.from({ length: maximumPresets }, (_, index) =>
      preset({
        id: `0182cc10-54d1-7c35-b4f3-e93bb4c0b2${String(index).padStart(2, "0")}`,
        description: `Newer ${index}`,
        lastUsedAt: `2026-08-27T${String(11 + index).padStart(2, "0")}:00:00Z`,
      }),
    );

    const upserted = upsertPreset(
      [matching, ...newer],
      { ...matching, projectName: "Renamed project" },
      "2026-08-28T00:00:00Z",
      () => "0182cc10-54d1-7c35-b4f3-e93bb4c0b999",
    );

    expect(upserted[0]).toMatchObject({ id: matching.id, projectName: "Renamed project" });
  });

  it("projects rich entry input to only persisted resume fields", () => {
    const richEntry = {
      ...preset(),
      userId: "303",
      start: "2026-08-27T10:00:00Z",
      stop: null,
      durationSeconds: null,
      updatedAt: "2026-08-27T10:00:01Z",
    };

    expect(
      upsertPreset(
        [],
        richEntry,
        "2026-08-27T12:00:00Z",
        () => "0182cc10-54d1-7c35-b4f3-e93bb4c0b999",
      ),
    ).toStrictEqual([
      {
        id: "0182cc10-54d1-7c35-b4f3-e93bb4c0b999",
        workspaceId: "202",
        description: "Review",
        projectId: "404",
        taskId: "505",
        tagIds: ["606", "607"],
        tags: ["client", "urgent"],
        billable: true,
        projectColor: "#c9806b",
        projectName: "Internal",
        taskName: "Write tests",
        lastUsedAt: "2026-08-27T12:00:00Z",
      },
    ]);
  });
});
