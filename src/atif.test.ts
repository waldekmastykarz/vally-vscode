import { convertFile, type Trajectory as AtifactTrajectory } from "atifact";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { convertHarToAtif } from "./atif.js";

vi.mock("atifact", () => ({ convertFile: vi.fn() }));

const mockedConvertFile = vi.mocked(convertFile);

describe("convertHarToAtif", () => {
  beforeEach(() => mockedConvertFile.mockReset());

  it("converts HAR through the atifact API", async () => {
    const trajectory = {
      schema_version: "ATIF-v1.8",
      session_id: "session-1",
      agent: { name: "copilot-chat", version: "1.0.0", model_name: "gpt-test" },
      steps: [{ step_id: 1, source: "user", message: "Hello" }],
    } satisfies AtifactTrajectory;
    mockedConvertFile.mockResolvedValue({ trajectory });

    await expect(convertHarToAtif("capture.har")).resolves.toBe(trajectory);
    expect(mockedConvertFile).toHaveBeenCalledWith("capture.har", { format: "har" });
  });

});