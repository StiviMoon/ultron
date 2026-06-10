// ── ULTRON v9 — integration tests ─────────────────────────────────────────────

import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const tmpDir = mkdtempSync(join(tmpdir(), "ultron-test-"));
process.env.ULTRON_DB_PATH = join(tmpDir, "test.db");

const memoryRepo = await import("../repositories/memory.repo.js");
const taskRepo = await import("../repositories/task.repo.js");
const sessionRepo = await import("../repositories/session.repo.js");
const syncRepo = await import("../repositories/sync.repo.js");
const { uuid } = await import("../db/connection.js");
const { isVecEnabled } = await import("../db/connection.js");

const PROJECT = "test-proj";

describe("memory lifecycle", () => {
  it("remember → search keyword → forget cleans memory", async () => {
    const id = uuid();
    memoryRepo.upsertMemory({
      id, project: PROJECT, key: "test-key", value: "unique-searchable-value-xyz",
      category: "fact", importance: 5, tool: "test", agent: null, expires_at: null, related: [],
    });

    const found = memoryRepo.ftsSearch("unique-searchable", [PROJECT], 5);
    expect(found.some((m) => m.key === "test-key")).toBe(true);

    const deleted = memoryRepo.deleteByKey(PROJECT, "test-key");
    expect(deleted).toBe(true);
    expect(memoryRepo.getByKey(PROJECT, "test-key")).toBeUndefined();
  });

  it("deleteMemories removes multiple keys in one transaction", () => {
    for (const k of ["bulk-a", "bulk-b"]) {
      memoryRepo.upsertMemory({
        id: uuid(), project: PROJECT, key: k, value: `value-${k}`,
        category: "note", importance: 3, tool: "test", agent: null, expires_at: null, related: [],
      });
    }
    const count = memoryRepo.deleteMemories(PROJECT, ["bulk-a", "bulk-b"]);
    expect(count).toBe(2);
    expect(memoryRepo.getByKey(PROJECT, "bulk-a")).toBeUndefined();
  });

  it("compress merges sources and deletes them", async () => {
    for (const k of ["cmp-a", "cmp-b"]) {
      memoryRepo.upsertMemory({
        id: uuid(), project: PROJECT, key: k, value: `compress source ${k}`,
        category: "fact", importance: 5, tool: "test", agent: null, expires_at: null, related: [],
      });
    }
    const result = await syncRepo.compressMemories(PROJECT, ["cmp-a", "cmp-b"], "cmp-merged", "merged value", "fact");
    expect(result.deletedKeys).toEqual(["cmp-a", "cmp-b"]);
    expect(memoryRepo.getByKey(PROJECT, "cmp-merged")?.value).toBe("merged value");
    expect(memoryRepo.getByKey(PROJECT, "cmp-a")).toBeUndefined();
  });
});

describe("session lifecycle", () => {
  it("session_start → session_end saves snapshot", async () => {
    const sessionId = sessionRepo.open(PROJECT, "test");
    expect(sessionId).toBeTruthy();

    const snapId = memoryRepo.saveSnapshot(PROJECT, "test snapshot content", "test", uuid());
    expect(snapId).toBeTruthy();

    const snap = memoryRepo.getByKey(PROJECT, "_snapshot");
    expect(snap?.value).toContain("test snapshot content");
  });
});

describe("task position", () => {
  it("resolveId uses priority order matching list", () => {
    const low = taskRepo.add(PROJECT, "low task", "low", [], "test");
    const high = taskRepo.add(PROJECT, "high task", "high", [], "test");

    const pending = taskRepo.pending(PROJECT);
    expect(pending[0]?.id).toBe(high);
    expect(pending[1]?.id).toBe(low);

    const resolved = taskRepo.resolveId(PROJECT, "1");
    expect(resolved).toBe(high);

    taskRepo.markDone(PROJECT, high);
    taskRepo.markDone(PROJECT, low);
    void low;
  });
});

describe("export/import", () => {
  it("round-trip preserves memories and tasks", async () => {
    const exportProject = "export-test";
    memoryRepo.upsertMemory({
      id: uuid(), project: exportProject, key: "exp-key", value: "export value",
      category: "fact", importance: 5, tool: "test", agent: null, expires_at: null, related: [],
    });
    taskRepo.add(exportProject, "export task", "medium", [], "test");

    const payload = syncRepo.exportProject(exportProject);
    expect(payload.counts.memories).toBeGreaterThanOrEqual(1);
    expect(payload.counts.tasks).toBeGreaterThanOrEqual(1);

    const counts = syncRepo.importProject(payload, "merge");
    expect(counts.memories).toBeGreaterThanOrEqual(1);
    expect(memoryRepo.getByKey(exportProject, "exp-key")?.value).toBe("export value");
  });
});

describe("vec status", () => {
  it("reports vec enabled state", () => {
    expect(typeof isVecEnabled()).toBe("boolean");
  });
});
