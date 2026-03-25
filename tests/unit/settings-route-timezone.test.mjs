import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-settings-route-timezone-"));
process.env.DATA_DIR = TEST_DATA_DIR;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
process.env.NODE_ENV = "test";

const core = await import("../../src/lib/db/core.ts");
const settingsDb = await import("../../src/lib/db/settings.ts");
const route = await import("../../src/app/api/settings/route.ts");

async function settleBackupTasks() {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

async function resetStorage() {
  await settleBackupTasks();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(async () => {
  await settleBackupTasks();
  process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("settings route exposes host and resolved system timezones", async () => {
  await settingsDb.updateSettings({ timeZone: "Asia/Shanghai" });

  const response = await route.GET();
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.timeZone, "Asia/Shanghai");
  assert.ok(typeof payload.hostTimeZone === "string" && payload.hostTimeZone.length > 0);
  assert.equal(payload.resolvedTimeZone, "Asia/Shanghai");
});

test("settings route falls back to host timezone when system timezone is blank", async () => {
  const response = await route.PATCH(
    new Request("http://localhost/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timeZone: "" }),
    })
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.timeZone, "");
  assert.ok(typeof payload.hostTimeZone === "string" && payload.hostTimeZone.length > 0);
  assert.equal(payload.resolvedTimeZone, payload.hostTimeZone);
});
