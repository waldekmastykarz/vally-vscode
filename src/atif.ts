import { validateAtifTrajectory } from "@microsoft/vally";
import type { AtifTrajectory } from "@microsoft/vally";
import { convertFile } from "atifact";

// Models of Copilot's background side-calls, such as the frustration classifier it runs on follow-up
// turns. Without this, the converter records their prompts as user steps, which start extra turns.
export const DEFAULT_UTILITY_MODELS = ["gpt-5.4-nano"];

export async function convertHarToAtif(
  harPath: string,
  utilityModels: readonly string[] = DEFAULT_UTILITY_MODELS,
): Promise<AtifTrajectory> {
  let trajectory: unknown;
  try {
    ({ trajectory } = await convertFile(harPath, { format: "har", utilityModels }));
  } catch (error) {
    throw new Error(`Failed to convert Dev Proxy HAR to ATIF: ${harPath}`, { cause: error });
  }
  return validateAtifTrajectory(trajectory);
}