import type { AtifTrajectory } from "@microsoft/vally";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { convertHarToAtif } from "./atif.js";
import { copyHarToArtifacts, startDevProxyCapture } from "./dev-proxy.js";
import { VSCodeExecutor } from "./executor.js";

vi.mock("./atif.js", () => ({ convertHarToAtif: vi.fn() }));
vi.mock("./dev-proxy.js", () => ({
  copyHarToArtifacts: vi.fn(),
  startDevProxyCapture: vi.fn(),
}));

const finalResponse = "VALLY_VSCODE_SMOKE_OK";
let fixtureDir: string | undefined;

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  if (fixtureDir) {
    await rm(fixtureDir, { recursive: true, force: true });
    fixtureDir = undefined;
  }
});

describe.skipIf(process.platform === "win32")("executor final response", () => {
  it.each([
    { capture: false, capturedMessage: "" },
    { capture: true, capturedMessage: "" },
    { capture: true, capturedMessage: "Earlier assistant narration" },
  ])("uses the VS Code response with capture=$capture and recorded text '$capturedMessage'", async ({
    capture,
    capturedMessage,
  }) => {
    const tmpRoot = path.join(process.cwd(), ".tmp");
    await mkdir(tmpRoot, { recursive: true });
    fixtureDir = await mkdtemp(path.join(tmpRoot, "executor-output-"));
    const executablePath = path.join(fixtureDir, "vscode.cjs");
    await writeFile(executablePath, `#!/usr/bin/env node
const net = require("node:net");
const { writeFileSync } = require("node:fs");
const server = net.createServer((socket) => {
  socket.setEncoding("utf8");
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\\n")) !== -1) {
      const { id, method, params } = JSON.parse(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      let result = null;
      if (method === "getStatus") result = { vscodeVersion: "1.144.0" };
      if (method === "executeCommand") {
        if (params.command === "workbench.action.chat.export") {
          writeFileSync(params.args[0].path, JSON.stringify({
            requests: [{ response: [{ value: ${JSON.stringify(finalResponse)} }] }],
          }));
        }
        if (params.command === "workbench.action.quit") {
          setTimeout(() => process.exit(0), 10);
        }
      }
      socket.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
    }
  });
});
server.listen(Number(process.env.VSCODE_CONTROLLER_PORT), "127.0.0.1");
`, { mode: 0o755 });

    vi.stubEnv("DEV_PROXY_PEM", capture ? path.join(fixtureDir, "certificate.pem") : "");
    const recorded: AtifTrajectory = {
      schema_version: "ATIF-v1.7",
      session_id: "captured-session",
      agent: { name: "copilot-chat", version: "test" },
      steps: [
        { step_id: 1, source: "user", message: "Create the requested files" },
        {
          step_id: 2,
          source: "agent",
          message: capturedMessage,
          tool_calls: [{
            tool_call_id: "complete-1",
            function_name: "task_complete",
            arguments: { summary: finalResponse },
          }],
        },
      ],
    };
    const capturePath = path.join(fixtureDir, "capture.har");
    const stop = vi.fn(async () => capturePath);
    const dispose = vi.fn(async () => undefined);
    vi.mocked(startDevProxyCapture).mockResolvedValue({
      proxyUrl: "http://127.0.0.1:8000",
      stop,
      dispose,
    });
    vi.mocked(copyHarToArtifacts).mockResolvedValue(capturePath);
    vi.mocked(convertHarToAtif).mockResolvedValue(recorded);

    const artifactDir = path.join(fixtureDir, "artifacts");
    const executor = new VSCodeExecutor();
    const trajectory = await executor.execute(
      { name: "final-response", prompt: "Create the requested files" },
      {
        workDir: fixtureDir,
        timeout: 5_000,
        executorConfig: {
          executablePath,
          userDataPath: path.join(fixtureDir, "User"),
        },
        sessionLog: {
          rootDir: path.join(fixtureDir, "session"),
          executorArtifactsDir: artifactDir,
        },
      },
    );

    expect(trajectory.output).toBe(finalResponse);
    if (capture) {
      expect(JSON.parse(await readFile(path.join(artifactDir, "trajectory.atif.json"), "utf8"))).toEqual(recorded);
      expect(stop).toHaveBeenCalledOnce();
      expect(dispose).toHaveBeenCalledOnce();
    } else {
      expect(startDevProxyCapture).not.toHaveBeenCalled();
    }
  });
});
