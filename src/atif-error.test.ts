import path from "node:path";
import { describe, expect, it } from "vitest";
import { convertHarToAtif } from "./atif.js";

describe("convertHarToAtif errors", () => {
  it("adds capture context to conversion errors", async () => {
    const harPath = path.join(process.cwd(), ".tmp", "missing-capture.har");
    const result = await convertHarToAtif(harPath).then(
      () => ({ rejected: false as const }),
      (error: unknown) => ({
        rejected: true as const,
        message: error instanceof Error ? error.message : String(error),
        hasCause: error instanceof Error && error.cause instanceof Error,
      }),
    );

    expect(result).toEqual({
      rejected: true,
      message: `Failed to convert Dev Proxy HAR to ATIF: ${harPath}`,
      hasCause: true,
    });
  });
});