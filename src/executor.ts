import type {
  AtifTrajectory,
  Executor,
  ExecutorOptions,
  McpServerConfig,
  Stimulus,
  Trajectory,
} from "@microsoft/vally";
import { fromAtif, mergeEnv, validateAtifTrajectory } from "@microsoft/vally";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { convertHarToAtif } from "./atif.js";
import {
  connectController,
  ControllerError,
  createControllerConnection,
  getResponseText,
  toVSCodeUri,
  type ControllerClient,
  type ExportedChat,
} from "./controller.js";
import {
  copyHarToArtifacts,
  startDevProxyCapture,
  type DevProxyCapture,
} from "./dev-proxy.js";
import {
  getVSCodePath,
  getVSCodeUserPath,
  getWorkspaceId,
  getWorkspaceStoragePath,
} from "./paths.js";

const execFileAsync = promisify(execFile);
const DEFAULT_CLOSE_TIMEOUT_MS = 30_000;
const CONTROLLER_CONNECT_TIMEOUT_MS = 120_000;
const MODEL_SELECT_ATTEMPTS = 10;
const HANDLED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

export interface VSCodeExecutorConfig {
  executablePath?: string;
  extensions?: string[];
  userDataPath?: string;
}

export type DiagnosticLogger = (message: string, details?: unknown) => void | Promise<void>;

interface McpConfiguration {
  servers?: Record<string, McpServerConfig>;
}

function parseConfig(value: unknown): VSCodeExecutorConfig {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("VS Code executor config must be an object");
  }

  const config = value as Record<string, unknown>;
  const allowed = new Set([
    "executablePath",
    "extensions",
    "userDataPath",
  ]);
  for (const key of Object.keys(config)) {
    if (!allowed.has(key)) throw new Error(`Unknown VS Code executor config property: ${key}`);
  }
  if (config.executablePath !== undefined && typeof config.executablePath !== "string") {
    throw new Error("VS Code executor config executablePath must be a string");
  }
  if (config.userDataPath !== undefined && typeof config.userDataPath !== "string") {
    throw new Error("VS Code executor config userDataPath must be a string");
  }
  if (
    config.extensions !== undefined &&
    (!Array.isArray(config.extensions) || config.extensions.some((item) => typeof item !== "string"))
  ) {
    throw new Error("VS Code executor config extensions must be an array of extension IDs");
  }

  return config as VSCodeExecutorConfig;
}

export class VSCodeExecutor implements Executor {
  readonly name = "vscode";
  readonly supportsPreparedWorkspace = true;
  readonly supportsMultiTurn = false;
  readonly supportsEnvVars = true;

  private executionQueue: Promise<void> = Promise.resolve();
  private activeProcess?: ChildProcess;
  private activeController?: ControllerClient;
  private activeOptions?: ExecutorOptions;
  private interruption?: NodeJS.Signals;
  private readonly closing = new WeakMap<ChildProcess, Promise<void>>();
  private readonly onSignal = (signal: NodeJS.Signals): void => this.interrupt(signal);

  constructor(private readonly logger?: DiagnosticLogger) { }

  validateConfig(config: unknown): void {
    parseConfig(config);
  }

  async execute(stimulus: Stimulus, options: ExecutorOptions): Promise<Trajectory> {
    const run = this.executionQueue.then(() => this.executeSerialized(stimulus, options));
    this.executionQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async shutdown(): Promise<void> {
    await this.executionQueue;
    if (this.activeProcess) await this.closeVSCode(this.activeProcess);
  }

  private async executeSerialized(stimulus: Stimulus, options: ExecutorOptions): Promise<Trajectory> {
    if (this.interruption) throw interruptedError(this.interruption);
    const startedAt = new Date();
    const sessionID = options.sessionID ?? randomUUID();
    const config = parseConfig(options.executorConfig);
    const executablePath = config.executablePath ?? getVSCodePath();
    if (/\binsiders\b/i.test(executablePath)) {
      throw new Error("VS Code Insiders is not supported. Configure the stable VS Code executable.");
    }
    const userPath = config.userDataPath ?? getVSCodeUserPath();
    const storagePath = path.join(userPath, "workspaceStorage", getWorkspaceId(options.workDir));
    const storageExisted = existsSync(storagePath);
    const restoreMcp = await this.configureMcp(options.workDir, options.mcpServers);
    let controller: ControllerClient | undefined;
    let devProxyCapture: DevProxyCapture | undefined;
    let devProxyRecordingSaved = false;

    await this.log(options, "Starting VS Code execution", {
      executablePath,
      userPath,
      workDir: options.workDir,
      workspaceStoragePath: storagePath,
      sessionID,
      stimulus: stimulus.name,
    });

    this.activeOptions = options;
    this.handleSignals();
    try {
      if (process.env.DEV_PROXY_PEM) {
        const captureRoot = options.sessionLog?.rootDir ?? options.sessionLog?.executorArtifactsDir;
        if (!captureRoot) {
          throw new Error("DEV_PROXY_PEM is set, but Vally did not provide a session log directory");
        }
        devProxyCapture = await startDevProxyCapture(path.join(captureRoot, "devproxy"));
        await this.log(options, "Dev Proxy recording started");
      } else {
        await this.log(options, "DEV_PROXY_PEM is not set; Dev Proxy trajectory capture is disabled");
      }

      if (config.extensions?.length) {
        await this.log(options, "Enabling VS Code extensions", { extensions: config.extensions });
        await this.enableExtensions(executablePath, options.workDir, userPath, config.extensions, options);
        await this.log(options, "VS Code extensions enabled");
      }

      await this.log(options, "Launching VS Code");
      let child: ChildProcess;
      ({ child, controller } = await this.startVSCode(executablePath, options.workDir, config.userDataPath, {
        ...mergeEnv(process.env, options.env),
        ...(devProxyCapture ? {
          HTTP_PROXY: devProxyCapture.proxyUrl,
          NODE_EXTRA_CA_CERTS: process.env.DEV_PROXY_PEM,
        } : {}),
      }, options));
      const status = await controller.call<{ vscodeVersion?: string }>("getStatus");
      const version = status.vscodeVersion ?? "unknown";
      await this.log(options, "VS Code workbench ready", status);
      const visibleOutput = await Promise.race([
        this.sendInstruction(
          controller,
          storagePath,
          stimulus.prompt,
          options.model,
          Math.min(options.timeout, options.maxAgentDurationMs ?? options.timeout),
          options,
        ),
        // Fails right away when VS Code exits instead of when the extension's connection drops.
        rejectOnExit(child),
      ]);
      await this.closeVSCode(child, options, controller);
      controller = undefined;
      const completedAt = new Date();
      let atif: AtifTrajectory;
      if (devProxyCapture) {
        devProxyRecordingSaved = true;
        const capturedHarPath = await devProxyCapture.stop();
        const harPath = options.sessionLog?.executorArtifactsDir
          ? await copyHarToArtifacts(capturedHarPath, options.sessionLog.executorArtifactsDir)
          : capturedHarPath;
        atif = await convertHarToAtif(harPath);
        if (options.sessionLog?.executorArtifactsDir) {
          await writeFile(
            path.join(options.sessionLog.executorArtifactsDir, "trajectory.atif.json"),
            `${JSON.stringify(atif, null, 2)}\n`,
            "utf8",
          );
        }
        await this.log(options, "Converted Dev Proxy HAR to ATIF", {
          stepCount: atif.steps.length,
          toolCallCount: atif.steps.reduce((count, step) => count + (step.tool_calls?.length ?? 0), 0),
        });
      } else {
        atif = {
          schema_version: "ATIF-v1.7",
          session_id: sessionID,
          agent: { name: "GitHub Copilot Chat", version, model_name: options.model },
          steps: [
            { step_id: 1, source: "user", message: stimulus.prompt, timestamp: startedAt.toISOString() },
            { step_id: 2, source: "agent", message: visibleOutput, timestamp: completedAt.toISOString() },
          ],
        };
      }
      validateAtifTrajectory(atif);
      const trajectory = fromAtif(atif, {
        stimulusName: stimulus.name,
        stimulusPrompt: stimulus.prompt,
        workDir: options.workDir,
      });
      trajectory.stimulus = stimulus;
      trajectory.metadata.startedAt = startedAt;
      trajectory.metadata.completedAt = completedAt;
      trajectory.metadata.executor = this.name;
      trajectory.metadata.sessionID = sessionID;
      trajectory.artifactDir = options.sessionLog?.executorArtifactsDir;
      for (const step of atif.steps) options.onRawEvent?.(step);
      await this.log(options, "VS Code execution completed", { durationMs: completedAt.getTime() - startedAt.getTime() });
      return trajectory;
    } catch (error) {
      if (this.interruption) throw interruptedError(this.interruption, error);
      throw error;
    } finally {
      if (this.activeProcess) await this.closeVSCode(this.activeProcess, options, controller);
      controller?.close();
      if (devProxyCapture) {
        // Keep the traffic captured before a failure; it's often what explains the failure.
        if (!devProxyRecordingSaved) await this.saveDevProxyRecording(devProxyCapture, options);
        await devProxyCapture.dispose();
      }
      await restoreMcp();
      if (!storageExisted) {
        try {
          await rm(storagePath, { recursive: true, force: true });
        } catch (error) {
          await this.log(options, "Failed to remove VS Code workspace storage", error);
          process.emitWarning(`Failed to remove VS Code workspace storage at ${storagePath}`);
        }
      }
      this.stopHandlingSignals();
      this.activeOptions = undefined;
      // The run is cleaned up; now let the signal terminate the process as it would have by default.
      if (this.interruption) reraiseUnlessHandled(this.interruption);
    }
  }

  // While a run is active, Ctrl+C or SIGTERM quits VS Code so the run fails fast and its cleanup
  // runs. VS Code is in its own process group, so it doesn't receive the terminal's signals itself.
  private handleSignals(): void {
    for (const signal of HANDLED_SIGNALS) process.on(signal, this.onSignal);
  }

  private stopHandlingSignals(): void {
    for (const signal of HANDLED_SIGNALS) process.off(signal, this.onSignal);
  }

  private interrupt(signal: NodeJS.Signals): void {
    if (this.interruption) {
      // A second signal means don't wait for a graceful shutdown.
      if (this.activeProcess) killVSCode(this.activeProcess);
      this.stopHandlingSignals();
      reraiseUnlessHandled(signal);
      return;
    }
    this.interruption = signal;
    void this.log(this.activeOptions, `Received ${signal}; stopping the run`);
    if (this.activeProcess) void this.closeVSCode(this.activeProcess, this.activeOptions, this.activeController);
  }

  // Launches VS Code with the controller enabled and connects to it. Connecting succeeds once the
  // workbench has started.
  private async startVSCode(
    executablePath: string,
    workDir: string,
    userDataPath: string | undefined,
    env: NodeJS.ProcessEnv,
    options: ExecutorOptions,
  ): Promise<{ child: ChildProcess; controller: ControllerClient }> {
    if (this.interruption) throw interruptedError(this.interruption);
    const connection = await createControllerConnection(workDir);
    const child = await launchVSCode(executablePath, this.launchArgs(workDir, userDataPath), { ...env, ...connection.env });
    this.activeProcess = child;
    child.once("exit", (code, signal) => {
      void this.log(options, "VS Code process exited", { code, signal });
    });
    await this.log(options, "VS Code launched", { pid: child.pid });
    const controller = await connectController({
      port: connection.port,
      token: connection.token,
      timeoutMs: CONTROLLER_CONNECT_TIMEOUT_MS,
      isAlive: () => isRunning(child) && !this.interruption,
    });
    if (this.activeProcess === child) this.activeController = controller;
    return { child, controller };
  }

  private async saveDevProxyRecording(capture: DevProxyCapture, options: ExecutorOptions): Promise<void> {
    try {
      const capturedHarPath = await capture.stop();
      const harPath = options.sessionLog?.executorArtifactsDir
        ? await copyHarToArtifacts(capturedHarPath, options.sessionLog.executorArtifactsDir)
        : capturedHarPath;
      await this.log(options, "Saved Dev Proxy recording from the failed run", { harPath });
    } catch (error) {
      await this.log(options, "Failed to save Dev Proxy recording from the failed run", error);
    }
  }

  // Assumes VS Code is configured for Autopilot, so the request runs to completion without approvals.
  private async sendInstruction(
    controller: ControllerClient,
    storagePath: string,
    instruction: string,
    model: string | undefined,
    timeoutMs: number,
    options: ExecutorOptions,
  ): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    await controller.call("chat.open");
    await this.log(options, "Copilot Chat opened");

    const mcpServerNames = Object.keys(options.mcpServers ?? {});
    if (mcpServerNames.length > 0) {
      await this.log(options, "Starting MCP servers", { servers: mcpServerNames });
      // VS Code IDs servers from the first workspace folder's .vscode/mcp.json as `mcp.config.ws0.<name>`.
      const results = await Promise.allSettled(mcpServerNames.map((name) =>
        controller.call("mcp.startServer", { serverId: `mcp.config.ws0.${name}`, waitForLiveTools: true })));
      for (const [index, result] of results.entries()) {
        if (result.status === "rejected") {
          await this.log(options, "Failed to start MCP server; continuing", {
            server: mcpServerNames[index],
            error: result.reason instanceof Error ? result.reason.message : String(result.reason),
          });
        }
      }
    }
    await this.log(options, "Starting new Copilot chat");
    await controller.call("chat.newChat");
    if (model) {
      await this.log(options, "Selecting Copilot model", { model });
      const selected = await this.selectModel(controller, model, options);
      await this.log(options, "Copilot model selected", selected);
    }

    const sending = controller.call<{ errorDetails?: unknown } | null>("chat.sendPrompt", { prompt: instruction });
    // After a timeout the pending call settles later; keep that from becoming an unhandled rejection.
    sending.catch(() => undefined);
    await this.log(options, "Copilot instruction submitted");
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), Math.max(0, deadline - Date.now()));
    });
    let result: Awaited<typeof sending> | "timeout";
    try {
      result = await Promise.race([sending, timedOut]);
    } catch (error) {
      if (error instanceof ControllerError && error.data !== undefined) {
        await this.log(options, "Copilot Chat request failed", error.data);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
    if (result === "timeout") {
      await controller.call("chat.cancel").catch(() => undefined);
      throw new Error(`VS Code Copilot Chat timed out after ${timeoutMs}ms`);
    }
    if (result?.errorDetails) {
      await this.log(options, "Copilot Chat response reported an error", result.errorDetails);
    }
    await this.log(options, "Copilot finished working");

    await controller.call("chat.keepAllEdits");
    return getResponseText(await this.exportChat(controller, storagePath));
  }

  private async selectModel(controller: ControllerClient, model: string, options: ExecutorOptions): Promise<unknown> {
    const params = model.toLowerCase() === "auto" ? { id: "auto" } : { name: model };
    // Models load asynchronously after startup, so retry while none matches.
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await controller.call("chat.selectModel", params);
      } catch (error) {
        const notLoaded = error instanceof Error && /^No language model(s found matching| named)/.test(error.message);
        if (!notLoaded) throw error;
        if (attempt >= MODEL_SELECT_ATTEMPTS) {
          throw new Error(`Model "${model}" isn't in the Copilot Chat model list`, { cause: error });
        }
        await this.log(options, `Model not available yet (attempt ${attempt}/${MODEL_SELECT_ATTEMPTS})`);
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    }
  }

  private async exportChat(controller: ControllerClient, storagePath: string): Promise<ExportedChat> {
    await mkdir(storagePath, { recursive: true });
    const file = path.join(storagePath, `vally-chat-${randomUUID()}.json`);
    try {
      await controller.call("executeCommand", { command: "workbench.action.chat.export", args: [toVSCodeUri(file)] });
      return JSON.parse(await readFile(file, "utf8")) as ExportedChat;
    } finally {
      await rm(file, { force: true });
    }
  }

  private async configureMcp(
    workDir: string,
    servers: Record<string, McpServerConfig> | undefined,
  ): Promise<() => Promise<void>> {
    if (!servers || Object.keys(servers).length === 0) return async () => undefined;
    const vscodeDir = path.join(workDir, ".vscode");
    const mcpPath = path.join(vscodeDir, "mcp.json");
    const original = existsSync(mcpPath) ? await readFile(mcpPath, "utf8") : undefined;
    let configuration: McpConfiguration = {};
    if (original) {
      try {
        configuration = JSON.parse(original) as McpConfiguration;
      } catch (error) {
        throw new Error(`Cannot configure MCP servers because ${mcpPath} is not valid JSON`, { cause: error });
      }
    }
    configuration.servers = { ...configuration.servers, ...servers };
    await mkdir(vscodeDir, { recursive: true });
    await writeFile(mcpPath, `${JSON.stringify(configuration, null, 2)}\n`, "utf8");

    return async () => {
      if (original === undefined) await rm(mcpPath, { force: true });
      else await writeFile(mcpPath, original, "utf8");
    };
  }

  private async enableExtensions(
    executablePath: string,
    workDir: string,
    userPath: string,
    extensions: string[],
    options: ExecutorOptions,
  ): Promise<void> {
    for (const extension of extensions) {
      if (!/^[\w-]+\.[\w-]+$/.test(extension)) {
        throw new Error(`Invalid VS Code extension ID: ${extension}`);
      }
    }
    // Start VS Code once so it creates the workspace's state database, then quit it so the
    // database can be changed without VS Code overwriting it.
    try {
      await this.startVSCode(
        executablePath,
        workDir,
        userPath === getVSCodeUserPath() ? undefined : userPath,
        process.env,
        options,
      );
    } finally {
      if (this.activeProcess) await this.closeVSCode(this.activeProcess, options, this.activeController);
    }

    const stateDbPath = path.join(userPath, "workspaceStorage", getWorkspaceId(workDir), "state.vscdb");
    if (!existsSync(stateDbPath)) throw new Error(`VS Code state database does not exist: ${stateDbPath}`);
    const value = JSON.stringify(extensions.map((id) => ({ id })));
    const sql =
      "INSERT OR REPLACE INTO ItemTable (key, value) VALUES ('extensionsIdentifiers/enabled', " +
      `'${value.replaceAll("'", "''")}');`;
    try {
      await execFileAsync("sqlite3", [stateDbPath, sql]);
    } catch (error) {
      throw new Error("Failed to enable VS Code extensions. Ensure sqlite3 is installed and on PATH.", { cause: error });
    }
  }

  private launchArgs(workDir: string, userDataPath?: string): string[] {
    const args = ["--disable-workspace-trust"];
    if (userDataPath) args.push("--user-data-dir", path.dirname(userDataPath));
    args.push(workDir);
    return args;
  }

  // Quits through VS Code's own command when the controller is connected, so VS Code shuts down
  // normally. Without it, for example when startup failed, sends SIGTERM, which Electron handles
  // by quitting the app. A signal and the run's own cleanup can both close VS Code, so concurrent
  // calls share one close.
  private closeVSCode(
    child: ChildProcess,
    options?: ExecutorOptions,
    controller?: ControllerClient,
  ): Promise<void> {
    let closing = this.closing.get(child);
    if (!closing) {
      closing = this.quitVSCode(child, options, controller);
      this.closing.set(child, closing);
    }
    return closing;
  }

  private async quitVSCode(
    child: ChildProcess,
    options?: ExecutorOptions,
    controller?: ControllerClient,
  ): Promise<void> {
    try {
      if (!isRunning(child)) return;
      if (controller) {
        // VS Code asks for confirmation while a chat or agent session is still in progress,
        // which the Copilot CLI agent session can briefly be after the response completes.
        await controller.call("executeCommand", {
          command: "setContext",
          args: ["chatSkipRequestInProgressMessage", true],
        });
        // VS Code exits before it can respond, which closes the connection.
        controller.call("executeCommand", { command: "workbench.action.quit" }).catch(() => undefined);
      } else {
        child.kill("SIGTERM");
      }
      await waitForExit(child, DEFAULT_CLOSE_TIMEOUT_MS);
    } catch (error) {
      await this.log(options, "Failed to close VS Code gracefully", error);
      killVSCode(child);
    } finally {
      controller?.close();
      if (this.activeProcess === child) {
        this.activeProcess = undefined;
        this.activeController = undefined;
      }
    }
  }

  private async log(options: ExecutorOptions | undefined, message: string, details?: unknown): Promise<void> {
    await this.logger?.(message, details);
    const artifactDir = options?.sessionLog?.executorArtifactsDir;
    if (!artifactDir) return;
    await mkdir(artifactDir, { recursive: true });
    const detailText = details === undefined ? "" : ` ${safeStringify(details)}`;
    await appendFile(path.join(artifactDir, "executor.log"), `${new Date().toISOString()} ${message}${detailText}\n`, "utf8");
  }
}

async function launchVSCode(executablePath: string, args: string[], env: NodeJS.ProcessEnv): Promise<ChildProcess> {
  // Debuggers and loaders such as tsx set NODE_OPTIONS for this process; VS Code must not inherit them.
  const vscodeEnv = { ...env };
  delete vscodeEnv.NODE_OPTIONS;
  // In its own process group, VS Code doesn't get the terminal's Ctrl+C, and killVSCode can stop
  // its whole process tree.
  const child = spawn(executablePath, args, {
    env: vscodeEnv,
    stdio: "ignore",
    detached: process.platform !== "win32",
  });
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
  } catch (error) {
    throw new Error(`Failed to launch VS Code at ${executablePath}`, { cause: error });
  }
  // Don't leave VS Code running when this process exits without closing it.
  const kill = (): void => killVSCode(child);
  process.once("exit", kill);
  child.once("exit", () => process.off("exit", kill));
  return child;
}

function killVSCode(child: ChildProcess): void {
  if (!isRunning(child)) return;
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch {
    // Exited in the meantime.
  }
}

function isRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function rejectOnExit(child: ChildProcess): Promise<never> {
  const exited = new Promise<never>((_, reject) => {
    const fail = (): void => {
      reject(new Error(`VS Code exited before the run finished (exit code ${child.exitCode}, signal ${child.signalCode})`));
    };
    if (isRunning(child)) child.once("exit", fail);
    else fail();
  });
  exited.catch(() => undefined);
  return exited;
}

function interruptedError(signal: NodeJS.Signals, cause?: unknown): Error {
  return new Error(`The VS Code run was interrupted by ${signal}`, { cause });
}

// Restores the default behavior of the signal, terminating the process, unless the host
// application handles the signal itself.
function reraiseUnlessHandled(signal: NodeJS.Signals): void {
  if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (!isRunning(child)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onExit = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      reject(new Error(`VS Code didn't quit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.once("exit", onExit);
  });
}

function safeStringify(value: unknown): string {
  if (value instanceof Error) return JSON.stringify({ name: value.name, message: value.message });
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify(String(value));
  }
}

export { getVSCodePath, getVSCodeUserPath, getWorkspaceId, getWorkspaceStoragePath };