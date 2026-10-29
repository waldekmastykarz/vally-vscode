import type { ExecutorOptions, McpServerConfig, Trajectory } from "@microsoft/vally";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getVSCodeUserPath, getWorkspaceId, VSCodeExecutor, type VSCodeExecutorConfig } from "../src/index.js";
import { findRunProcesses, stopRunProcesses } from "./cleanup.js";

interface DebugProfile {
  name?: string;
  prompt: string;
  model?: string;
  extensions?: string[];
  mcpServers?: Record<string, McpServerConfig>;
  env?: Record<string, string>;
  workspace?: string;
  timeoutMs?: number;
  devProxy?: boolean;
  devProxyPem?: string;
  executorConfig?: Omit<VSCodeExecutorConfig, "extensions">;
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmpRoot = path.join(repoRoot, ".tmp");
const runsRoot = path.join(tmpRoot, "debug-runs");
const lastProfileFile = path.join(tmpRoot, "debug-last-profile");
const DEFAULT_TIMEOUT_MS = 60 * 60_000;

// F5 passes the active editor file. When it isn't a profile (for example, you're looking
// at src/executor.ts after setting a breakpoint), fall back to the last profile you ran.
async function resolveProfilePath(arg: string | undefined): Promise<string> {
  if (arg && arg.endsWith(".json") && path.basename(arg) !== "profile.schema.json" && existsSync(arg)) {
    const profilePath = path.resolve(arg);
    await mkdir(tmpRoot, { recursive: true });
    await writeFile(lastProfileFile, profilePath, "utf8");
    return profilePath;
  }
  if (existsSync(lastProfileFile)) {
    const lastProfile = (await readFile(lastProfileFile, "utf8")).trim();
    if (existsSync(lastProfile)) {
      console.log(`Active file is not a debug profile; reusing last profile: ${lastProfile}`);
      return lastProfile;
    }
  }
  throw new Error(
    "No debug profile selected. Open a profile JSON file (for example debug/profiles/example.json) and press F5.",
  );
}

function parseProfile(value: unknown, profilePath: string): DebugProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Debug profile must be a JSON object: ${profilePath}`);
  }
  const profile = value as Record<string, unknown>;
  const allowed = new Set([
    "$schema",
    "name",
    "prompt",
    "model",
    "extensions",
    "mcpServers",
    "env",
    "workspace",
    "timeoutMs",
    "devProxy",
    "devProxyPem",
    "executorConfig",
  ]);
  for (const key of Object.keys(profile)) {
    if (!allowed.has(key)) throw new Error(`Unknown debug profile property "${key}" in ${profilePath}`);
  }
  if (typeof profile.prompt !== "string" || !profile.prompt.trim()) {
    throw new Error(`Debug profile "prompt" must be a non-empty string: ${profilePath}`);
  }
  return profile as unknown as DebugProfile;
}

// The executor reads DEV_PROXY_PEM from the environment to decide whether to capture traffic.
function configureDevProxy(profile: DebugProfile, profileDir: string): void {
  if (profile.devProxy === false) {
    delete process.env.DEV_PROXY_PEM;
    return;
  }
  if (profile.devProxyPem) process.env.DEV_PROXY_PEM = path.resolve(profileDir, profile.devProxyPem);
  const pem = process.env.DEV_PROXY_PEM;
  if (pem && !existsSync(pem)) throw new Error(`Dev Proxy certificate not found: ${pem}`);
  if (profile.devProxy === true && !pem) {
    throw new Error('Debug profile sets "devProxy": true, but neither "devProxyPem" nor DEV_PROXY_PEM is set');
  }
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

// Safety net for sessions that were force-killed before they could clean up.
async function stopLeftoverProcesses(): Promise<void> {
  const leftovers = findRunProcesses(runsRoot + path.sep);
  if (leftovers.length === 0) return;
  console.log("Stopping processes left over from previous debug runs:");
  for (const { kind, pid } of leftovers) console.log(`  ${kind} (pid ${pid})`);
  await stopRunProcesses(leftovers);
}

let shuttingDown = false;
let execution: Promise<Trajectory> | undefined;

// Stopping the debugger (with "killBehavior": "polite") or pressing Ctrl+C: the executor quits
// VS Code and runs its own cleanup (it saves the Dev Proxy HAR, stops Dev Proxy and removes
// workspace storage). Wait for that, then stop anything that cleanup didn't get to.
function installShutdownHandlers(runDir: string, workspaceStoragePath: string): void {
  const onSignal = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log(`\nReceived ${signal}; closing VS Code and saving the Dev Proxy recording...`);
    void (async () => {
      if (execution) await Promise.race([execution.catch(() => undefined), sleep(60_000)]);
      await stopRunProcesses(findRunProcesses(runDir + path.sep));
      await rm(workspaceStoragePath, { recursive: true, force: true });
    })()
      .catch((error: unknown) => console.error("Cleanup failed:", error))
      .finally(() => {
        console.log(`Artifacts: ${path.join(runDir, "executor-artifacts")}`);
        process.exit(128 + constants.signals[signal]);
      });
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, onSignal);
}

// Crashing on an unexpected error, for example while VS Code is closing, would skip the
// executor's cleanup, leaving Dev Proxy running and its recording unsaved.
function logUnhandledError(error: unknown): void {
  if (shuttingDown) return; // Expected while VS Code is being closed.
  console.error("Unhandled error (ignored so the executor can clean up):", error);
}
process.on("uncaughtException", logUnhandledError);
process.on("unhandledRejection", logUnhandledError);

async function main(): Promise<void> {
  const profilePath = await resolveProfilePath(process.argv[2]);
  const profileDir = path.dirname(profilePath);
  const profile = parseProfile(JSON.parse(await readFile(profilePath, "utf8")), profilePath);
  const profileName = profile.name ?? path.basename(profilePath, ".json");

  await stopLeftoverProcesses();

  const runDir = path.join(runsRoot, `${profileName}-${timestamp()}`);
  const workDir = path.join(runDir, "workspace");
  const artifactsDir = path.join(runDir, "executor-artifacts");
  await mkdir(workDir, { recursive: true });
  if (profile.workspace) {
    const fixture = path.resolve(profileDir, profile.workspace);
    if (!existsSync(fixture)) throw new Error(`Workspace fixture not found: ${fixture}`);
    await cp(fixture, workDir, { recursive: true });
  }

  configureDevProxy(profile, profileDir);

  const executorConfig: VSCodeExecutorConfig = {
    ...profile.executorConfig,
    ...(profile.extensions ? { extensions: profile.extensions } : {}),
  };
  const executor = new VSCodeExecutor((message, details) => {
    const detailText =
      details === undefined ? "" : ` ${details instanceof Error ? details.message : JSON.stringify(details)}`;
    console.log(`[${new Date().toISOString()}] ${message}${detailText}`);
  });
  executor.validateConfig(executorConfig);

  // Each run uses a brand-new workspace, so any workspace storage for it was created by this run.
  const userPath = executorConfig.userDataPath ?? getVSCodeUserPath();
  installShutdownHandlers(runDir, path.join(userPath, "workspaceStorage", getWorkspaceId(workDir)));

  const options: ExecutorOptions = {
    timeout: profile.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    workDir,
    model: profile.model,
    executorConfig,
    mcpServers: profile.mcpServers,
    env: profile.env,
    sessionLog: { rootDir: path.join(runDir, "session"), executorArtifactsDir: artifactsDir },
  };

  console.log(`Profile:   ${profilePath}`);
  console.log(`Run dir:   ${runDir}`);
  console.log(`Dev Proxy: ${process.env.DEV_PROXY_PEM ? `enabled (${process.env.DEV_PROXY_PEM})` : "disabled"}`);

  try {
    execution = executor.execute({ name: profileName, prompt: profile.prompt }, options);
    const trajectory = await execution;
    const trajectoryPath = path.join(runDir, "trajectory.json");
    await writeFile(trajectoryPath, `${JSON.stringify(trajectory, null, 2)}\n`, "utf8");
    console.log(`\nFinal output:\n${trajectory.output || "(none)"}\n`);
    console.log(`Trajectory: ${trajectoryPath}`);
    console.log(`Artifacts:  ${artifactsDir}`);
  } finally {
    await executor.shutdown();
  }
}

main().catch((error: unknown) => {
  if (shuttingDown) return;
  console.error(error);
  process.exitCode = 1;
});
