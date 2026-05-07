import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "fs";
import os from "os";
import path from "path";

// Set up a unique temp dir for plan files — must be set before plan-store loads.
const tmpDir = path.join(os.tmpdir(), `evchargeboss-plan-store-test-${process.pid}`);
mkdirSync(tmpDir, { recursive: true });
process.env.PLANS_DIR = tmpDir;

import {
  timestampForFilename,
  planFilePath,
  findNewestPlanFile,
  readPlanFile,
  writePlanFile,
  cleanOldPlanFiles,
} from "../src/utils/plan-store.ts";

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("timestampForFilename", () => {
  test("replaces colons with dashes", () => {
    const d = new Date("2026-04-18T14:30:00");
    const ts = timestampForFilename(d);
    assert.ok(!ts.includes(":"), "should not contain colons");
    assert.match(ts, /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/);
  });
});

describe("writePlanFile / readPlanFile", () => {
  test("roundtrips JSON data", () => {
    const filePath = planFilePath("test-rw", timestampForFilename(new Date()));
    const data = { version: 1 as const, foo: "bar", n: 42 };
    writePlanFile(filePath, data);
    const result = readPlanFile<typeof data>(filePath);
    assert.deepEqual(result, data);
  });

  test("creates parent directories automatically", () => {
    const filePath = path.join(tmpDir, ".plans", "nested", "test-nested.json");
    writePlanFile(filePath, { ok: true });
    assert.ok(existsSync(filePath));
  });

  test("readPlanFile returns null for missing file", () => {
    const result = readPlanFile("/nonexistent/path/that/does/not/exist.json");
    assert.equal(result, null);
  });

  test("readPlanFile returns null for invalid JSON", () => {
    const filePath = planFilePath("test-invalid", "2026-01-01T00-00-00");
    writePlanFile(filePath, "placeholder");
    writeFileSync(filePath, "not valid json");
    const result = readPlanFile(filePath);
    assert.equal(result, null);
  });
});

describe("findNewestPlanFile", () => {
  test("returns null when no matching files exist", () => {
    const result = findNewestPlanFile("prefix-that-does-not-exist");
    assert.equal(result, null);
  });

  test("returns null when plans dir does not exist", () => {
    const savedPlansDir = process.env.PLANS_DIR;
    process.env.PLANS_DIR = path.join(tmpDir, "nonexistent-subdir");
    const result = findNewestPlanFile("ev-charging");
    process.env.PLANS_DIR = savedPlansDir;
    assert.equal(result, null);
  });

  test("returns the alphabetically newest file for the given prefix", () => {
    const prefix = "test-newest";
    writePlanFile(planFilePath(prefix, "2026-04-18T10-00-00"), { v: 1 });
    writePlanFile(planFilePath(prefix, "2026-04-18T12-00-00"), { v: 2 });
    writePlanFile(planFilePath(prefix, "2026-04-18T08-00-00"), { v: 3 });

    const result = findNewestPlanFile(prefix);
    assert.ok(result !== null);
    assert.ok(result.includes("2026-04-18T12-00-00"), `expected T12 but got ${result}`);
  });

  test("does not return files from a different prefix", () => {
    writePlanFile(planFilePath("other-prefix", "2099-01-01T00-00-00"), { v: 9 });
    const result = findNewestPlanFile("test-isolated");
    assert.equal(result, null);
  });
});

describe("cleanOldPlanFiles", () => {
  test("deletes files older than retention period", async () => {
    process.env.PLANS_RETENTION_DAYS = "0";

    const filePath = planFilePath("test-cleanup", "2026-01-01T00-00-00");
    writePlanFile(filePath, { old: true });
    assert.ok(existsSync(filePath));

    // Wait a tick so mtime is definitely in the past relative to Date.now().
    await new Promise((r) => setTimeout(r, 10));

    cleanOldPlanFiles();
    assert.ok(!existsSync(filePath), "old file should have been deleted");

    delete process.env.PLANS_RETENTION_DAYS;
  });

  test("keeps files within retention period", () => {
    process.env.PLANS_RETENTION_DAYS = "7";

    const filePath = planFilePath("test-keep", "2026-04-18T09-00-00");
    writePlanFile(filePath, { recent: true });

    cleanOldPlanFiles();
    assert.ok(existsSync(filePath), "recent file should not be deleted");

    delete process.env.PLANS_RETENTION_DAYS;
  });

  test("does not throw when plans dir does not exist", () => {
    const savedPlansDir = process.env.PLANS_DIR;
    process.env.PLANS_DIR = path.join(tmpDir, "no-such-dir");
    assert.doesNotThrow(() => cleanOldPlanFiles());
    process.env.PLANS_DIR = savedPlansDir;
  });
});
