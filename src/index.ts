import type { ExecutorRegistry } from "@microsoft/vally";
import { VSCodeExecutor } from "./executor.js";

export function registerExecutors(registry: ExecutorRegistry): void {
  registry.register(new VSCodeExecutor());
}

export { VSCodeExecutor } from "./executor.js";
export type { DiagnosticLogger, VSCodeExecutorConfig } from "./executor.js";
export { convertHarToAtif } from "./atif.js";
export {
  copyHarToArtifacts,
  createDevProxyConfig,
  parseDevProxyStartOutput,
  startDevProxyCapture,
} from "./dev-proxy.js";
export {
  getVSCodePath,
  getVSCodeUserPath,
  getWorkspaceId,
  getWorkspaceStoragePath,
  normalizeWorkspacePath,
  resolveVSCodePath,
  resolveVSCodeUserPath,
} from "./paths.js";