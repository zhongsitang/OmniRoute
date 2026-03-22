import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

test("db core fails closed and preserves the existing sqlite file when probing fails", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-db-core-"));
  const sqlitePath = path.join(tempDir, "storage.sqlite");
  const coreModuleUrl = pathToFileURL(path.join(process.cwd(), "src/lib/db/core.ts")).href;

  try {
    fs.writeFileSync(sqlitePath, "not-a-valid-sqlite-database", "utf8");

    const result = spawnSync(
      process.execPath,
      ["--import", "tsx/esm", "--input-type=module", "-"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        input: `
          process.env.DATA_DIR = ${JSON.stringify(tempDir)};
          try {
            const core = await import(${JSON.stringify(coreModuleUrl)});
            core.getDbInstance();
            console.log("unexpected-success");
            process.exit(0);
          } catch (error) {
            console.error(error instanceof Error ? error.message : String(error));
            process.exit(17);
          }
        `,
      }
    );

    assert.equal(result.status, 17);
    assert.equal(fs.existsSync(sqlitePath), true);
    assert.match(result.stderr, /preserved the file and aborted startup/i);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
