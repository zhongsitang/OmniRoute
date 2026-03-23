#!/usr/bin/env node

import {
  removeStandaloneAppArtifacts,
  resolveRuntimePorts,
  sanitizeColorEnv,
  spawnWithForwardedSignals,
  withRuntimePortEnv,
} from "./runtime-env.mjs";

const mode = process.argv[2] === "start" ? "start" : "dev";
const cwd = process.cwd();
removeStandaloneAppArtifacts(cwd, console);

const runtimePorts = resolveRuntimePorts();
const testServerEnv = {
  ...sanitizeColorEnv(process.env),
  OMNIROUTE_DISABLE_TOKEN_HEALTHCHECK: process.env.OMNIROUTE_DISABLE_TOKEN_HEALTHCHECK || "1",
  OMNIROUTE_HIDE_HEALTHCHECK_LOGS: process.env.OMNIROUTE_HIDE_HEALTHCHECK_LOGS || "1",
};
const args = [
  "./node_modules/next/dist/bin/next",
  mode,
  "--port",
  String(runtimePorts.dashboardPort),
];
if (mode === "dev") {
  args.splice(2, 0, "--webpack");
}

spawnWithForwardedSignals(process.execPath, args, {
  stdio: "inherit",
  env: withRuntimePortEnv(testServerEnv, runtimePorts),
});
