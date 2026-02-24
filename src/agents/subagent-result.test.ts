import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { waitForSubagentResultArtifact } from "./subagent-result.js";

describe("subagent result artifact validation", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs
        .splice(0, tempDirs.length)
        .map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  async function createTempResultPath(runId: string): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-subagent-result-"));
    tempDirs.push(dir);
    const resultPath = path.join(dir, "projects", "project-foo", "runs", runId, "result.json");
    await fs.mkdir(path.dirname(resultPath), { recursive: true });
    return resultPath;
  }

  it("accepts valid result JSON with required association fields", async () => {
    const runId = "run-child-1";
    const resultPath = await createTempResultPath(runId);
    await fs.writeFile(
      resultPath,
      JSON.stringify({
        status: "done",
        finishedAt: "2026-02-24T00:00:00.000Z",
        summary: ["Completed requested task"],
        outputs: ["/tmp/output.txt"],
        project: "project-foo",
        epochId: 7,
        runId,
        parentRunId: "run-parent-1",
      }),
      "utf8",
    );

    const result = await waitForSubagentResultArtifact({
      resultPath,
      expected: {
        projectStem: "project-foo",
        epochId: 7,
        runId,
        parentRunId: "run-parent-1",
      },
      timeoutMs: 50,
      pollIntervalMs: 5,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.result.status).toBe("done");
    expect(result.result.project).toBe("project-foo");
    expect(result.result.runId).toBe(runId);
    expect(result.result.parentRunId).toBe("run-parent-1");
  });

  it("times out on invalid result JSON without soft-pass", async () => {
    const runId = "run-child-2";
    const resultPath = await createTempResultPath(runId);
    await fs.writeFile(
      resultPath,
      JSON.stringify({
        status: "done",
        finishedAt: "2026-02-24T00:00:00.000Z",
        summary: ["Completed requested task"],
        outputs: ["/tmp/output.txt"],
        project: "project-foo",
        epochId: 7,
        runId,
      }),
      "utf8",
    );

    const result = await waitForSubagentResultArtifact({
      resultPath,
      expected: {
        projectStem: "project-foo",
        epochId: 7,
        runId,
        parentRunId: "run-parent-2",
      },
      timeoutMs: 30,
      pollIntervalMs: 5,
    });

    expect(result).toEqual({
      ok: false,
      reason: "invalid-parentRunId",
    });
  });

  it("times out deterministically when result JSON is missing", async () => {
    const runId = "run-child-3";
    const resultPath = await createTempResultPath(runId);
    await fs.rm(resultPath, { force: true });

    const result = await waitForSubagentResultArtifact({
      resultPath,
      expected: {
        projectStem: "project-foo",
        epochId: 7,
        runId,
        parentRunId: "run-parent-3",
      },
      timeoutMs: 30,
      pollIntervalMs: 5,
    });

    expect(result).toEqual({
      ok: false,
      reason: "missing-result-json",
    });
  });
});
