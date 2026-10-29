import { execFile } from "node:child_process";
import { copyFile, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const START_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 30_000;

interface DevProxyStartResult {
  pid: number;
  proxyUrl: string;
  apiUrl: string;
  token?: string;
  logFile?: string;
}

export interface DevProxyApi {
  apiUrl: string;
  /** Dev Proxy 4 requires a bearer token for its API; earlier versions don't. */
  token?: string;
}

export interface DevProxyCapture {
  proxyUrl: string;
  stop(): Promise<string>;
  dispose(): Promise<void>;
}

export async function startDevProxyCapture(captureDir: string): Promise<DevProxyCapture> {
  const absoluteCaptureDir = path.resolve(captureDir);
  await mkdir(absoluteCaptureDir, { recursive: true });
  const configPath = path.join(absoluteCaptureDir, "devproxyrc.json");
  await writeFile(configPath, `${JSON.stringify(createDevProxyConfig(), null, 2)}\n`, "utf8");
  const startedAt = Date.now();
  const { stdout } = await execFileAsync(
    "devproxy",
    [
      "--config-file",
      configPath,
      "--record",
      "--detach",
      "--output",
      "json",
      "--no-first-run",
    ],
    { cwd: absoluteCaptureDir, timeout: START_TIMEOUT_MS },
  );
  const result = parseDevProxyStartOutput(stdout);
  // Dev Proxy omits the token from its startup output when CI is set.
  const api: DevProxyApi = {
    apiUrl: result.apiUrl,
    token: result.token ?? (await getDevProxyApi(result.pid).catch(() => undefined))?.token,
  };
  let disposed = false;
  let recordingStopped = false;

  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    try {
      await execFileAsync("devproxy", ["stop", "--pid", String(result.pid)], {
        timeout: STOP_TIMEOUT_MS,
      });
    } catch {
      try {
        process.kill(result.pid, "SIGKILL");
      } catch {
        // The detached process has already exited.
      }
    }
  };

  return {
    proxyUrl: result.proxyUrl,
    async stop(): Promise<string> {
      if (!recordingStopped) {
        await stopDevProxyRecording(api);
        recordingStopped = true;
      }
      const harPath = await findGeneratedHar(absoluteCaptureDir, startedAt);
      if (!harPath) {
        throw new Error(
          `Dev Proxy recorded no Copilot traffic, so it didn't generate a HAR file in ${absoluteCaptureDir}. ` +
            "If Copilot couldn't connect through Dev Proxy, check that DEV_PROXY_PEM contains Dev Proxy's current " +
            "root certificate and that the certificate is trusted (devproxy cert ensure)." +
            (result.logFile ? ` Dev Proxy log: ${result.logFile}` : ""),
        );
      }
      return harPath;
    },
    dispose,
  };
}

export function parseDevProxyStartOutput(stdout: string): DevProxyStartResult {
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as {
        type?: string;
        data?: Partial<DevProxyStartResult>;
      };
      const data = parsed.data;
      if (
        parsed.type === "result" &&
        typeof data?.pid === "number" &&
        typeof data.proxyUrl === "string" &&
        typeof data.apiUrl === "string"
      ) {
        return {
          pid: data.pid,
          proxyUrl: data.proxyUrl,
          apiUrl: data.apiUrl,
          token: typeof data.token === "string" ? data.token.trim() : undefined,
          logFile: typeof data.logFile === "string" ? data.logFile : undefined,
        };
      }
    } catch {
      // Detached output can include non-JSON informational lines.
    }
  }
  throw new Error(`Failed to parse Dev Proxy startup output: ${stdout}`);
}

/** Looks up the API address and token of a running Dev Proxy 4 instance. */
export async function getDevProxyApi(pid: number): Promise<DevProxyApi> {
  const { stdout } = await execFileAsync("devproxy", ["api", "token", "--pid", String(pid), "--output", "json"], {
    timeout: START_TIMEOUT_MS,
  });
  const parsed = JSON.parse(stdout) as { apiUrl?: unknown; token?: unknown };
  if (typeof parsed.apiUrl !== "string" || typeof parsed.token !== "string") {
    throw new Error(`Unexpected devproxy api token output: ${stdout}`);
  }
  return { apiUrl: parsed.apiUrl, token: parsed.token.trim() };
}

/** Stops recording, which makes Dev Proxy's HAR generator write the captured traffic to disk. */
export async function stopDevProxyRecording(api: DevProxyApi): Promise<void> {
  await setRecording(api, false);
  await waitForRecordingToStop(api);
}

export function createDevProxyConfig(): Record<string, unknown> {
  return {
    $schema: "https://raw.githubusercontent.com/dotnet/dev-proxy/main/schemas/v4.0.0/rc.schema.json",
    plugins: [
      {
        name: "HarGeneratorPlugin",
        enabled: true,
        pluginPath: "~appFolder/plugins/DevProxy.Plugins.dll",
        configSection: "harGeneratorPlugin",
      },
    ],
    urlsToWatch: ["https://api.enterprise.githubcopilot.com/*"],
    harGeneratorPlugin: {
      $schema: "https://raw.githubusercontent.com/dotnet/dev-proxy/main/schemas/v4.0.0/hargeneratorplugin.schema.json",
      includeSensitiveInformation: false,
      includeResponse: true,
    },
    apiPort: 0,
    port: 0,
    logLevel: "information",
    newVersionNotification: "stable",
    showSkipMessages: true,
    asSystemProxy: false,
  };
}

export async function copyHarToArtifacts(harPath: string, artifactDir: string): Promise<string> {
  await mkdir(artifactDir, { recursive: true });
  const destination = path.join(artifactDir, "vscode-copilot.har");
  await copyFile(harPath, destination);
  return destination;
}

function apiHeaders(api: DevProxyApi): Record<string, string> {
  return api.token ? { Authorization: `Bearer ${api.token}` } : {};
}

async function setRecording(api: DevProxyApi, recording: boolean): Promise<void> {
  const response = await fetch(`${api.apiUrl}/proxy`, {
    method: "POST",
    headers: { ...apiHeaders(api), "Content-Type": "application/json" },
    body: JSON.stringify({ recording }),
  });
  if (!response.ok) {
    throw new Error(`Failed to update Dev Proxy recording: ${response.status} ${response.statusText}`);
  }
}

async function waitForRecordingToStop(api: DevProxyApi): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await fetch(`${api.apiUrl}/proxy`, { headers: apiHeaders(api) });
    if (!response.ok) throw new Error(`Failed to get Dev Proxy status: ${response.status}`);
    const status = await response.json() as { recording?: boolean };
    if (status.recording === false) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("Timed out waiting for Dev Proxy recording to stop");
}

export async function findGeneratedHar(captureDir: string, startedAt = 0): Promise<string | undefined> {
  const candidates: Array<{ filePath: string; modifiedAt: number }> = [];
  for (const name of await readdir(captureDir)) {
    if (!name.endsWith(".har")) continue;
    const filePath = path.join(captureDir, name);
    const fileStat = await stat(filePath);
    if (fileStat.mtimeMs >= startedAt) candidates.push({ filePath, modifiedAt: fileStat.mtimeMs });
  }
  candidates.sort((left, right) => right.modifiedAt - left.modifiedAt);
  return candidates[0]?.filePath;
}