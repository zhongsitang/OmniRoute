#!/usr/bin/env node

import { existsSync, renameSync } from "node:fs";
import path from "node:path";
import {
  resolveRuntimePorts,
  withRuntimePortEnv,
  spawnWithForwardedSignals,
} from "./runtime-env.mjs";
import { bootstrapEnv } from "./bootstrap-env.mjs";

const mode = process.argv[2] === "start" ? "start" : "dev";

const runtimePorts = resolveRuntimePorts();
const { dashboardPort } = runtimePorts;

function setupDevAppDirWorkaround() {
  if (mode !== "dev") return;

  const projectRoot = process.cwd();
  const rootAppDir = path.join(projectRoot, "app");
  const srcAppDir = path.join(projectRoot, "src", "app");
  const hiddenAppDir = path.join(projectRoot, "app.__next_dev_hidden");

  const rootAppLooksPackaged =
    existsSync(path.join(rootAppDir, "package.json")) &&
    existsSync(path.join(rootAppDir, "src", "app"));

  let shouldRestore = false;
  let restoreFrom = hiddenAppDir;

  const reserveHiddenPath = () => {
    if (!existsSync(hiddenAppDir)) return hiddenAppDir;

    let suffix = 1;
    let candidate = `${hiddenAppDir}.${suffix}`;
    while (existsSync(candidate)) {
      suffix += 1;
      candidate = `${hiddenAppDir}.${suffix}`;
    }
    return candidate;
  };

  if (!existsSync(rootAppDir) && existsSync(hiddenAppDir)) {
    shouldRestore = true;
  } else if (
    existsSync(rootAppDir) &&
    existsSync(srcAppDir) &&
    rootAppLooksPackaged &&
    !existsSync(hiddenAppDir)
  ) {
    renameSync(rootAppDir, hiddenAppDir);
    shouldRestore = true;
    console.log(
      "[dev-bootstrap] Temporarily hid the conflicting top-level app/ directory so Next.js uses src/app."
    );
  } else if (existsSync(rootAppDir) && existsSync(srcAppDir) && rootAppLooksPackaged) {
    restoreFrom = reserveHiddenPath();
    renameSync(rootAppDir, restoreFrom);
    shouldRestore = true;
    console.log(
      `[dev-bootstrap] Found an existing app.__next_dev_hidden directory; temporarily moved the conflicting top-level app/ to ${path.basename(restoreFrom)} so Next.js uses src/app.`
    );
  }

  if (!shouldRestore) return;

  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;

    if (existsSync(restoreFrom) && !existsSync(rootAppDir)) {
      renameSync(restoreFrom, rootAppDir);
      console.log("[dev-bootstrap] Restored the top-level app/ directory.");
    }
  };

  process.on("exit", restore);
  process.on("SIGINT", restore);
  process.on("SIGTERM", restore);
}

// Auto-generate secrets on first run, merge .env + process.env
const env = bootstrapEnv();
setupDevAppDirWorkaround();

const args = ["./node_modules/next/dist/bin/next", mode, "--port", String(dashboardPort)];
// Default: use webpack (stable). Set OMNIROUTE_USE_TURBOPACK=1 to use Turbopack (faster dev).
if (mode === "dev" && process.env.OMNIROUTE_USE_TURBOPACK !== "1") {
  args.splice(2, 0, "--webpack");
}

spawnWithForwardedSignals(process.execPath, args, {
  stdio: "inherit",
  env: withRuntimePortEnv(env, runtimePorts),
});
