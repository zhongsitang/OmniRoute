import { spawn } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

export function parsePort(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 65535 ? parsed : fallback;
}

export function resolveRuntimePorts() {
  const basePort = parsePort(process.env.PORT || "20128", 20128);
  const apiPort = parsePort(process.env.API_PORT || String(basePort), basePort);
  const dashboardPort = parsePort(process.env.DASHBOARD_PORT || String(basePort), basePort);

  return { basePort, apiPort, dashboardPort };
}

export function withRuntimePortEnv(env, runtimePorts) {
  const { basePort, apiPort, dashboardPort } = runtimePorts;

  return {
    ...env,
    OMNIROUTE_PORT: String(basePort),
    PORT: String(dashboardPort),
    DASHBOARD_PORT: String(dashboardPort),
    API_PORT: String(apiPort),
  };
}

export function sanitizeColorEnv(env = {}) {
  const sanitized = { ...env };

  // Node warns when both FORCE_COLOR and NO_COLOR are set.
  // Prefer NO_COLOR in test tooling to avoid noisy process warnings.
  if (typeof sanitized.FORCE_COLOR !== "undefined" && typeof sanitized.NO_COLOR !== "undefined") {
    delete sanitized.FORCE_COLOR;
  }

  return sanitized;
}

function isStandaloneBuildDir(dir) {
  return (
    existsSync(join(dir, "server.js")) &&
    existsSync(join(dir, "package.json")) &&
    existsSync(join(dir, ".next")) &&
    existsSync(join(dir, "src", "app"))
  );
}

export function removeStandaloneAppArtifacts(projectRoot, logger = console) {
  const srcAppDir = join(projectRoot, "src", "app");
  if (!existsSync(srcAppDir)) return [];

  const candidates = readdirSync(projectRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter(
      (name) =>
        name === "app" ||
        name === "app.__qa_backup" ||
        name === "app.__next_dev_hidden" ||
        name.startsWith("app.__next_dev_hidden.")
    );

  const removed = [];
  for (const name of candidates) {
    const targetDir = join(projectRoot, name);
    if (!isStandaloneBuildDir(targetDir)) continue;

    rmSync(targetDir, { recursive: true, force: true });
    removed.push(name);
  }

  if (removed.length > 0) {
    logger.log(`[dev-bootstrap] Removed conflicting standalone artifact(s): ${removed.join(", ")}`);
  }

  return removed;
}

export function spawnWithForwardedSignals(command, args, options = {}) {
  const child = spawn(command, args, options);

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });

  process.on("SIGINT", () => child.kill("SIGINT"));
  process.on("SIGTERM", () => child.kill("SIGTERM"));

  return child;
}
