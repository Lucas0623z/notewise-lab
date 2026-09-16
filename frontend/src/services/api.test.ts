import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "../types";

function project(): Project {
  return {
    id: "demo-test",
    title: "Original",
    status: "empty",
    bpm: 120,
    timeSignature: "4/4",
    durationSeconds: 0,
    revision: 0,
    createdAt: "2026-09-15T10:00:00Z",
    updatedAt: "2026-09-15T10:00:00Z",
    sourceAudioUrl: null,
    latestJobId: null,
    tracks: [],
    warnings: [],
  };
}

let persisted: Project[];
let write: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
  persisted = [project()];
  write = vi.fn(async (projects: Project[]) => {
    persisted = structuredClone(projects);
  });
  vi.stubGlobal("window", {
    desktop: {
      mode: "demo",
      readDemoProjects: async () => structuredClone(persisted),
      writeDemoProjects: write,
    },
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("persistent demo transactions", () => {
  it("rejects a concurrent stale save instead of silently overwriting the first save", async () => {
    const { api, ApiError } = await import("./api");
    const first = { ...project(), title: "First save" };
    const second = { ...project(), title: "Concurrent save" };
    const results = await Promise.allSettled([
      api.saveProject(first),
      api.saveProject(second),
    ]);
    expect(results[0].status).toBe("fulfilled");
    expect(results[1].status).toBe("rejected");
    if (results[1].status === "rejected") {
      expect(results[1].reason).toBeInstanceOf(ApiError);
      expect(results[1].reason.status).toBe(409);
    }
    expect(persisted[0]).toMatchObject({ title: "First save", revision: 1 });
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("captures the submitted snapshot before the asynchronous transaction starts", async () => {
    const { api } = await import("./api");
    const draft = { ...project(), title: "Submitted" };
    const pending = api.saveProject(draft);
    draft.title = "Edited during save";
    expect((await pending).title).toBe("Submitted");
    expect(persisted[0].title).toBe("Submitted");
  });

  it("recovers after a write failure and preserves both concurrent project creations", async () => {
    const { api } = await import("./api");
    write.mockRejectedValueOnce(new Error("Storage full"));
    await expect(api.saveProject(project())).rejects.toThrow("Storage full");
    expect(persisted[0].revision).toBe(0);
    const created = await Promise.all([
      api.createProject({ title: "New one" }),
      api.createProject({ title: "New two" }),
    ]);
    expect(created).toHaveLength(2);
    expect(new Set(persisted.map((item) => item.id)).size).toBe(3);
    expect(persisted.map((item) => item.title)).toContain("New one");
    expect(persisted.map((item) => item.title)).toContain("New two");
  });
});
