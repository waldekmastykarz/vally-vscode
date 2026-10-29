import { validateAtifTrajectory } from "@microsoft/vally";
import type { AtifTrajectory } from "@microsoft/vally";
import { convertFile } from "atifact";

export async function convertHarToAtif(harPath: string): Promise<AtifTrajectory> {
  let trajectory: unknown;
  try {
    ({ trajectory } = await convertFile(harPath, { format: "har" }));
  } catch (error) {
    throw new Error(`Failed to convert Dev Proxy HAR to ATIF: ${harPath}`, { cause: error });
  }
  return validateAtifTrajectory(trajectory);
}