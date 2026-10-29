import { randomBytes } from "node:crypto";
import net from "node:net";
import { pathToFileURL } from "node:url";

// JSON-RPC client for the VS Code Controller extension (waldek.vscode-controller).
export const CONTROLLER_EXTENSION_ID = "waldek.vscode-controller";

export class ControllerError extends Error {
  constructor(message: string, readonly code?: number, readonly data?: unknown) {
    super(message);
    this.name = "ControllerError";
  }
}

interface RpcResponse {
  id?: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export class ControllerClient {
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();

  constructor(private readonly socket: net.Socket) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.onData(chunk));
    socket.on("error", () => undefined);
    socket.on("close", () => {
      for (const { reject } of this.pending.values()) reject(new ControllerError("Connection to VS Code closed"));
      this.pending.clear();
    });
  }

  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (this.socket.destroyed) return Promise.reject(new ControllerError("Connection to VS Code closed"));
    const id = this.nextId++;
    const message = { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) };
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.socket.write(`${JSON.stringify(message)}\n`);
    });
  }

  close(): void {
    this.socket.destroy();
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let index: number;
    while ((index = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      for (const response of [JSON.parse(line) as RpcResponse | RpcResponse[]].flat()) {
        const pending = response.id === undefined ? undefined : this.pending.get(response.id);
        if (!pending) continue;
        this.pending.delete(response.id!);
        if (response.error) {
          pending.reject(new ControllerError(response.error.message, response.error.code, response.error.data));
        } else {
          pending.resolve(response.result);
        }
      }
    }
  }
}

export interface ControllerConnection {
  port: number;
  token: string;
  env: Record<string, string>;
}

/** Picks a free port and token, and returns the environment variables that enable the controller in VS Code. */
export async function createControllerConnection(workDir: string): Promise<ControllerConnection> {
  const port = await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
  const token = randomBytes(32).toString("hex");
  return {
    port,
    token,
    env: {
      VSCODE_CONTROLLER_PORT: String(port),
      VSCODE_CONTROLLER_TOKEN: token,
      // Only the window with the trial workspace listens, not windows VS Code restores.
      VSCODE_CONTROLLER_WORKSPACE: workDir,
    },
  };
}

export interface ConnectOptions {
  port: number;
  token: string;
  timeoutMs: number;
  /** Stops retrying when this returns false, for example because VS Code exited. */
  isAlive?: () => boolean;
}

/**
 * Connects and authenticates. The extension opens its socket only after VS Code finishes
 * starting up, so a successful connection also means the workbench is ready.
 */
export async function connectController({ port, token, timeoutMs, isAlive }: ConnectOptions): Promise<ControllerClient> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const socket = await new Promise<net.Socket>((resolve, reject) => {
        const s = net.connect(port, "127.0.0.1", () => resolve(s));
        s.once("error", reject);
      });
      const client = new ControllerClient(socket);
      try {
        await client.call("authenticate", { token });
      } catch (error) {
        client.close();
        throw error;
      }
      return client;
    } catch (error) {
      const refused = (error as NodeJS.ErrnoException).code === "ECONNREFUSED";
      if (!refused) throw error;
      if (Date.now() >= deadline || (isAlive && !isAlive())) {
        throw new Error(
          `Couldn't connect to the VS Code Controller extension on port ${port}. ` +
            `Make sure ${CONTROLLER_EXTENSION_ID} is installed and enabled, and that no other stable VS Code window is open.`,
          { cause: error },
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

/** The subset of a `workbench.action.chat.export` file the executor reads. */
export interface ExportedChat {
  requests?: ExportedRequest[];
}

export interface ExportedRequest {
  response?: ExportedResponsePart[];
}

type ExportedResponsePart = {
  kind?: string;
  value?: unknown;
  name?: string;
  inlineReference?: { path?: string; uri?: { path?: string } };
};

/** Returns the markdown of all responses in the chat, one entry per markdown block, like the chat view renders it. */
export function getResponseText(chat: ExportedChat): string {
  const blocks: string[] = [];
  for (const request of chat.requests ?? []) {
    let current: string | undefined;
    for (const part of request.response ?? []) {
      // The export flattens markdown parts to their `IMarkdownString`, which has no `kind`.
      if (part.kind === undefined && typeof part.value === "string") {
        current = (current ?? "") + part.value;
      } else if (part.kind === "inlineReference" && current !== undefined) {
        const refPath = part.inlineReference?.path ?? part.inlineReference?.uri?.path ?? "";
        current += part.name ?? refPath.split("/").pop() ?? "";
      } else if (current !== undefined) {
        blocks.push(current);
        current = undefined;
      }
    }
    if (current !== undefined) blocks.push(current);
  }
  return blocks.join("\n").trim();
}

/** Marshals a file path as a VS Code URI so `executeCommand` revives it. */
export function toVSCodeUri(filePath: string): { $mid: 1; scheme: "file"; path: string } {
  return { $mid: 1, scheme: "file", path: decodeURIComponent(pathToFileURL(filePath).pathname) };
}
