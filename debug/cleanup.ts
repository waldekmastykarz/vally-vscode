import { execFileSync } from "node:child_process";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  copyHarToArtifacts,
  findGeneratedHar,
  getDevProxyApi,
  stopDevProxyRecording,
} from "../src/dev-proxy.js";

export interface RunProcess {
  pid: number;
  kind: "Dev Proxy" | "VS Code";
  configFile?: string;
}

// Finds Dev Proxy and VS Code main processes whose command line references `scope`
// (a debug run folder). Dev Proxy runs detached, so it isn't part of the debugged
// process tree and must be found by its config path.
export function findRunProcesses(scope: string): RunProcess[] {
  if (process.platform === "win32") return [];
  let stdout: string;
  try {
    stdout = execFileSync("ps", ["-axww", "-o", "pid=,command="], { encoding: "utf8" });
  } catch {
    return [];
  }
  const found: RunProcess[] = [];
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const command = match[2];
    if (pid === process.pid || !command.includes(scope)) continue;
    const configFile = /--config-file (.+?devproxyrc\.json)/.exec(command)?.[1];
    if (/\bdevproxy\b/.test(command) && configFile) {
      found.push({ pid, kind: "Dev Proxy", configFile });
    } else if (command.includes("--disable-workspace-trust") && !command.includes("--type=")) {
      // The executor launches VS Code with --disable-workspace-trust; helper processes have --type=.
      found.push({ pid, kind: "VS Code" });
    }
  }
  return found;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signalAll(processes: RunProcess[], signal: NodeJS.Signals): void {
  for (const { pid } of processes) {
    try {
      process.kill(pid, signal);
    } catch {
      // Already exited.
    }
  }
}

// SIGTERM is sent synchronously so it goes out even if something else exits the
// process before the returned promise settles.
export function terminateProcesses(processes: RunProcess[], graceMs = 10_000): Promise<void> {
  signalAll(processes, "SIGTERM");
  return (async () => {
    const deadline = Date.now() + graceMs;
    while (processes.some(({ pid }) => isAlive(pid)) && Date.now() < deadline) await sleep(200);
    signalAll(processes.filter(({ pid }) => isAlive(pid)), "SIGKILL");
  })();
}

// Dev Proxy only writes the HAR when recording stops, so stop it before killing the process.
// The run folder layout is <runDir>/session/devproxy/devproxyrc.json.
async function saveRecording({ pid, configFile }: RunProcess): Promise<void> {
  if (!configFile) return;
  const captureDir = path.dirname(configFile);
  const artifactsDir = path.resolve(captureDir, "..", "..", "executor-artifacts");
  try {
    await stopDevProxyRecording(await getDevProxyApi(pid));
    const harPath = await findGeneratedHar(captureDir);
    if (harPath) {
      console.log(`  Saved Dev Proxy recording: ${await copyHarToArtifacts(harPath, artifactsDir)}`);
    } else {
      console.log(`  Dev Proxy (pid ${pid}) recorded no Copilot traffic; no HAR to save`);
    }
  } catch (error) {
    console.log(`  Couldn't save the Dev Proxy (pid ${pid}) recording: ${error instanceof Error ? error.message : error}`);
  }
}

/** Closes VS Code, saves each Dev Proxy recording, then stops Dev Proxy. */
export async function stopRunProcesses(processes: RunProcess[]): Promise<void> {
  await terminateProcesses(processes.filter(({ kind }) => kind === "VS Code"));
  const devProxies = processes.filter(({ kind }) => kind === "Dev Proxy");
  for (const devProxy of devProxies) await saveRecording(devProxy);
  await terminateProcesses(devProxies);
}
