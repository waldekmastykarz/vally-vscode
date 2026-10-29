import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { homedir, platform } from "node:os";
import path from "node:path";

export function resolveVSCodePath(
  operatingSystem: NodeJS.Platform,
  homeDir: string,
  env: NodeJS.ProcessEnv,
): string {
  if (env.VSCODE_PATH) return env.VSCODE_PATH;

  switch (operatingSystem) {
    case "darwin":
      return "/Applications/Visual Studio Code.app/Contents/MacOS/Code";
    case "linux":
      return "/usr/bin/code";
    case "win32": {
      const localAppData = env.LOCALAPPDATA ?? path.win32.join(homeDir, "AppData", "Local");
      return path.win32.join(localAppData, "Programs", "Microsoft VS Code", "Code.exe");
    }
    default:
      throw new Error(`Unsupported platform: ${operatingSystem}`);
  }
}

export function getVSCodePath(env: NodeJS.ProcessEnv = process.env): string {
  return resolveVSCodePath(platform(), homedir(), env);
}

export function resolveVSCodeUserPath(
  operatingSystem: NodeJS.Platform,
  homeDir: string,
  env: NodeJS.ProcessEnv,
): string {
  switch (operatingSystem) {
    case "darwin":
      return path.join(homeDir, "Library", "Application Support", "Code", "User");
    case "linux":
      return path.join(homeDir, ".config", "Code", "User");
    case "win32": {
      const appData = env.APPDATA ?? path.win32.join(homeDir, "AppData", "Roaming");
      return path.win32.join(appData, "Code", "User");
    }
    default:
      throw new Error(`Unsupported platform: ${operatingSystem}`);
  }
}

export function getVSCodeUserPath(env: NodeJS.ProcessEnv = process.env): string {
  return resolveVSCodeUserPath(platform(), homedir(), env);
}

export function normalizeWorkspacePath(
  workspacePath: string,
  operatingSystem: NodeJS.Platform = platform(),
): string {
  const absolutePath = path.resolve(workspacePath);
  return operatingSystem === "win32"
    ? absolutePath.substring(0, 1).toLowerCase() + absolutePath.substring(1)
    : absolutePath;
}

export function getWorkspaceId(workspacePath: string, operatingSystem = platform()): string {
  const absolutePath = normalizeWorkspacePath(workspacePath, operatingSystem);

  let creationIdentity: number | undefined;
  try {
    const stat = statSync(absolutePath);
    if (operatingSystem === "win32") creationIdentity = Math.floor(stat.birthtimeMs);
    if (operatingSystem === "darwin") creationIdentity = stat.birthtime.getTime();
    if (operatingSystem === "linux") creationIdentity = stat.ino;
  } catch {
    // VS Code hashes the path without a creation identity when the workspace is unavailable.
  }

  return createHash("md5")
    .update(absolutePath)
    .update(creationIdentity === undefined ? "" : String(creationIdentity))
    .digest("hex");
}

export function getWorkspaceStoragePath(
  workspacePath: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(getVSCodeUserPath(env), "workspaceStorage", getWorkspaceId(workspacePath));
}