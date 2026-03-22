import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-dashboard-auth-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.JWT_SECRET = "x".repeat(32);

const core = await import("../../src/lib/db/core.ts");
const settingsDb = await import("../../src/lib/db/settings.ts");
const { NextRequest } = await import("next/server");
const { proxy } = await import("../../src/proxy.ts");

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
  delete process.env.INITIAL_PASSWORD;
  await resetStorage();
});

test.after(async () => {
  delete process.env.INITIAL_PASSWORD;
  await settleBackupTasks();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("dashboard settings ignores stale auth cookies when no password is configured", async () => {
  await settingsDb.updateSettings({
    requireLogin: true,
    setupComplete: true,
  });

  const response = await proxy(
    new NextRequest("http://localhost:20128/dashboard/settings?tab=security", {
      headers: {
        cookie: "auth_token=stale-token",
      },
    })
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("location"), null);
  assert.match(response.headers.get("set-cookie") || "", /auth_token=;/);
});

test("dashboard routes still redirect to login when a password exists and the cookie is invalid", async () => {
  await settingsDb.updateSettings({
    requireLogin: true,
    setupComplete: true,
    password: "hashed-password",
  });

  const response = await proxy(
    new NextRequest("http://localhost:20128/dashboard/settings?tab=security", {
      headers: {
        cookie: "auth_token=stale-token",
      },
    })
  );

  assert.equal(response.status, 307);
  assert.equal(response.headers.get("location"), "http://localhost:20128/login");
  assert.match(response.headers.get("set-cookie") || "", /auth_token=;/);
});
