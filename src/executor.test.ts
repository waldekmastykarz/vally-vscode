import { createExecutorRegistry } from "@microsoft/vally";
import { describe, expect, it, vi } from "vitest";
import { VSCodeExecutor } from "./executor.js";
import { registerExecutors } from "./index.js";

describe("VSCodeExecutor", () => {
  it("registers under the vscode name", () => {
    const registry = createExecutorRegistry();
    registerExecutors(registry);
    expect(registry.get("vscode")).toBeInstanceOf(VSCodeExecutor);
  });

  it("accepts supported configuration", () => {
    const executor = new VSCodeExecutor();
    expect(() =>
      executor.validateConfig({
        executablePath: "/opt/code",
        extensions: ["github.copilot-chat"],
      }),
    ).not.toThrow();
  });

  it("rejects unknown configuration", () => {
    const executor = new VSCodeExecutor();
    expect(() => executor.validateConfig({ unexpected: true })).toThrow(
      "Unknown VS Code executor config property: unexpected",
    );
  });

  it("rejects VS Code Insiders", async () => {
    const executor = new VSCodeExecutor();
    await expect(executor.execute(
      { name: "test", prompt: "test" },
      {
        timeout: 1_000,
        workDir: process.cwd(),
        executorConfig: {
          executablePath: "/Applications/Visual Studio Code - Insiders.app/Contents/MacOS/Code - Insiders",
        },
      },
    )).rejects.toThrow("VS Code Insiders is not supported");
  });

  it("does not advertise unsupported multi-turn execution", () => {
    const executor = new VSCodeExecutor();
    expect(executor.supportsMultiTurn).toBe(false);
  });

  it("reports a missing VS Code executable", async () => {
    vi.stubEnv("DEV_PROXY_PEM", "");
    try {
      const executor = new VSCodeExecutor();
      await expect(executor.execute(
        { name: "test", prompt: "test" },
        {
          timeout: 1_000,
          workDir: process.cwd(),
          executorConfig: { executablePath: "/nonexistent/Visual Studio Code/Code" },
        },
      )).rejects.toThrow("Failed to launch VS Code at /nonexistent/Visual Studio Code/Code");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});