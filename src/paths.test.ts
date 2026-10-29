import { createHash } from "node:crypto";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  getWorkspaceId,
  normalizeWorkspacePath,
  resolveVSCodePath,
  resolveVSCodeUserPath,
} from "./paths.js";

describe("VS Code paths", () => {
  it("uses redirected Windows application-data directories", () => {
    const env = {
      LOCALAPPDATA: "D:\\Local",
      APPDATA: "E:\\Roaming",
    };

    expect(resolveVSCodePath("win32", "C:\\Users\\user", env)).toBe(
      "D:\\Local\\Programs\\Microsoft VS Code\\Code.exe",
    );
    expect(resolveVSCodeUserPath("win32", "C:\\Users\\user", env)).toBe(
      "E:\\Roaming\\Code\\User",
    );
  });

  it("falls back to the Windows home directory", () => {
    expect(resolveVSCodePath("win32", "C:\\Users\\user", {})).toBe(
      "C:\\Users\\user\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe",
    );
    expect(resolveVSCodeUserPath("win32", "C:\\Users\\user", {})).toBe(
      "C:\\Users\\user\\AppData\\Roaming\\Code\\User",
    );
  });

  it("honors VSCODE_PATH on every platform", () => {
    expect(resolveVSCodePath("linux", "/home/user", { VSCODE_PATH: "/opt/code" })).toBe(
      "/opt/code",
    );
  });

});

describe("workspace identity", () => {
  it("lowercases the first character for Windows workspace IDs", () => {
    const workspace = path.resolve("C:\\Source\\Project");
    expect(normalizeWorkspacePath("C:\\Source\\Project", "win32")).toBe(
      workspace.substring(0, 1).toLowerCase() + workspace.substring(1),
    );
  });

  it("hashes a missing workspace without a creation identity", () => {
    const missing = path.resolve("missing-workspace-for-vscode-executor-test");
    const expected = createHash("md5").update(missing).update("").digest("hex");
    expect(getWorkspaceId(missing, "aix")).toBe(expected);
  });
});