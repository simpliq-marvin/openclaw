import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveAgentOrchRunResultPath } from "./runs.js";

describe("agent-orch-v1 run paths", () => {
  it("uses canonical project run result path under stateDir", () => {
    const cfg: OpenClawConfig = {
      agentOrchV1: {
        stateDir: "/tmp/openclaw-state",
      },
    };
    const resultPath = resolveAgentOrchRunResultPath({
      cfg,
      projectStem: "project-foo",
      runId: "run-123",
    });
    expect(resultPath).toBe(
      path.join("/tmp/openclaw-state", "projects", "project-foo", "runs", "run-123", "result.json"),
    );
  });
});
