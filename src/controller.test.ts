import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  connectController,
  ControllerError,
  createControllerConnection,
  getResponseText,
  toVSCodeUri,
} from "./controller.js";

type Handler = (method: string, params: Record<string, unknown> | undefined) => unknown;

const servers: net.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

function startFakeController(token: string, handler: Handler, port = 0): Promise<number> {
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let index: number;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const { id, method, params } = JSON.parse(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        let response: Record<string, unknown>;
        if (method === "authenticate") {
          response = params?.token === token
            ? { result: { authenticated: true } }
            : { error: { code: -32001, message: "Invalid token" } };
        } else {
          try {
            response = { result: handler(method, params) ?? null };
          } catch (error) {
            const { code, message, data } = error as ControllerError;
            response = { error: { code, message, data } };
          }
        }
        socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, ...response })}\n`);
      }
    });
  });
  servers.push(server);
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve((server.address() as net.AddressInfo).port)));
}

describe("controller client", () => {
  it("authenticates and calls methods", async () => {
    const port = await startFakeController("secret", (method, params) => ({ method, params }));
    const client = await connectController({ port, token: "secret", timeoutMs: 1_000 });
    try {
      await expect(client.call("chat.selectModel", { name: "Example" })).resolves.toEqual({
        method: "chat.selectModel",
        params: { name: "Example" },
      });
    } finally {
      client.close();
    }
  });

  it("rejects with the JSON-RPC error code and data", async () => {
    const port = await startFakeController("secret", () => {
      throw new ControllerError("Model mismatch", -32000, { served: "other" });
    });
    const client = await connectController({ port, token: "secret", timeoutMs: 1_000 });
    try {
      await expect(client.call("chat.sendPrompt", { prompt: "hi" })).rejects.toMatchObject({
        message: "Model mismatch",
        code: -32000,
        data: { served: "other" },
      });
    } finally {
      client.close();
    }
  });

  it("rejects calls after the connection is closed", async () => {
    const port = await startFakeController("secret", () => "ok");
    const client = await connectController({ port, token: "secret", timeoutMs: 1_000 });
    client.close();
    await expect(client.call("getStatus")).rejects.toThrow("Connection to VS Code closed");
  });

  it("fails on an invalid token", async () => {
    const port = await startFakeController("secret", () => null);
    await expect(connectController({ port, token: "wrong", timeoutMs: 1_000 })).rejects.toThrow("Invalid token");
  });

  it("retries until the socket opens", async () => {
    const { port } = await createControllerConnection(process.cwd());
    setTimeout(() => void startFakeController("secret", () => "ok", port), 700);
    const client = await connectController({ port, token: "secret", timeoutMs: 5_000 });
    try {
      await expect(client.call("getStatus")).resolves.toBe("ok");
    } finally {
      client.close();
    }
  });

  it("stops retrying when VS Code exits", async () => {
    const { port } = await createControllerConnection(process.cwd());
    await expect(connectController({ port, token: "secret", timeoutMs: 60_000, isAlive: () => false })).rejects.toThrow(
      "Make sure waldek.vscode-controller is installed and enabled",
    );
  });

  it("scopes the controller to the workspace", async () => {
    const connection = await createControllerConnection("/work/dir");
    expect(connection.env).toEqual({
      VSCODE_CONTROLLER_PORT: String(connection.port),
      VSCODE_CONTROLLER_TOKEN: connection.token,
      VSCODE_CONTROLLER_WORKSPACE: "/work/dir",
    });
    expect(connection.token).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("chat export", () => {
  it("joins markdown blocks across requests and tool calls", () => {
    const text = getResponseText({
      requests: [
        {
          response: [
            { value: "Updating " },
            { kind: "inlineReference", inlineReference: { path: "/work/src/app.ts" } },
            { value: " now." },
            { kind: "toolInvocationSerialized" },
            { value: "Done." },
          ],
        },
        { response: [{ value: "Continued." }] },
      ],
    });
    expect(text).toBe("Updating app.ts now.\nDone.\nContinued.");
  });

  it("marshals file paths as VS Code URIs", () => {
    expect(toVSCodeUri("/work dir/chat.json")).toEqual({ $mid: 1, scheme: "file", path: "/work dir/chat.json" });
  });
});
