import { afterEach, describe, expect, it, vi } from "vitest";
import { createDevProxyConfig, parseDevProxyStartOutput, stopDevProxyRecording } from "./dev-proxy.js";

describe("parseDevProxyStartOutput", () => {
  it("reads the detached process result after informational output", () => {
    const output = [
      "Starting Dev Proxy",
      JSON.stringify({
        type: "result",
        data: {
          pid: 123,
          proxyUrl: "http://127.0.0.1:8000",
          apiUrl: "http://127.0.0.1:8001",
        },
      }),
    ].join("\n");

    expect(parseDevProxyStartOutput(output)).toEqual({
      pid: 123,
      proxyUrl: "http://127.0.0.1:8000",
      apiUrl: "http://127.0.0.1:8001",
    });
  });

  it("reads the API token and log file reported by Dev Proxy 4", () => {
    const output = JSON.stringify({
      type: "result",
      data: {
        pid: 123,
        proxyUrl: "http://127.0.0.1:8000",
        apiUrl: "http://127.0.0.1:8001",
        token: "ABC123\n",
        logFile: "/logs/devproxy-123.log",
      },
    });

    expect(parseDevProxyStartOutput(output)).toMatchObject({
      token: "ABC123",
      logFile: "/logs/devproxy-123.log",
    });
  });

  it("rejects output without a complete result", () => {
    expect(() => parseDevProxyStartOutput('{"type":"log"}')).toThrow(
      "Failed to parse Dev Proxy startup output",
    );
  });
});

describe("stopDevProxyRecording", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("authenticates API requests with the bearer token", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ recording: false }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await stopDevProxyRecording({ apiUrl: "http://127.0.0.1:8001", token: "ABC123" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchMock.mock.calls as unknown as Array<[string, RequestInit]>) {
      expect(init.headers).toMatchObject({ Authorization: "Bearer ABC123" });
    }
    expect(fetchMock.mock.calls[0]).toEqual([
      "http://127.0.0.1:8001/proxy",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ recording: false }) }),
    ]);
  });

  it("omits authorization for Dev Proxy versions without API tokens", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ recording: false }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await stopDevProxyRecording({ apiUrl: "http://127.0.0.1:8001" });

    for (const [, init] of fetchMock.mock.calls as unknown as Array<[string, RequestInit]>) {
      expect(init.headers).not.toHaveProperty("Authorization");
    }
  });
});

describe("createDevProxyConfig", () => {
  it("captures Copilot traffic without sensitive request data", () => {
    const config = createDevProxyConfig();

    expect(config.urlsToWatch).toEqual(["https://api.enterprise.githubcopilot.com/*"]);
    expect(config.harGeneratorPlugin).toMatchObject({
      includeSensitiveInformation: false,
      includeResponse: true,
    });
    expect(config).toMatchObject({ asSystemProxy: false, apiPort: 0, port: 0 });
  });
});