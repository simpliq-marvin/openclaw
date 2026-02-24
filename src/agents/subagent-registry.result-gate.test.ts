import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const noop = () => {};
const mocks = vi.hoisted(() => ({
  stateDir: "",
  callGateway: vi.fn(),
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: (...args: unknown[]) => mocks.callGateway(...args),
}));

vi.mock("../infra/agent-events.js", () => ({
  onAgentEvent: vi.fn(() => noop),
}));

vi.mock("./subagent-announce.js", () => ({
  runSubagentAnnounceFlow: vi.fn(async () => true),
  buildSubagentSystemPrompt: vi.fn(() => "test prompt"),
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: vi.fn(() => null),
}));

vi.mock("../config/config.js", () => ({
  loadConfig: vi.fn(() => ({
    agentOrchV1: {
      enabled: true,
      stateDir: mocks.stateDir,
      subagents: {
        pollIntervalMs: 5,
        resultTimeoutMs: 40,
      },
    },
    agents: {
      defaults: {
        subagents: {
          archiveAfterMinutes: 60,
        },
      },
    },
  })),
}));

vi.mock("./subagent-registry.store.js", () => ({
  loadSubagentRegistryFromDisk: vi.fn(() => new Map()),
  saveSubagentRegistryToDisk: vi.fn(() => {}),
}));

describe("subagent registry result gate", () => {
  let mod: typeof import("./subagent-registry.js");
  let tempDir: string | null = null;

  beforeAll(async () => {
    mod = await import("./subagent-registry.js");
  });

  beforeEach(() => {
    mocks.callGateway.mockReset();
    mocks.callGateway.mockImplementation(async (request: unknown) => {
      const method = (request as { method?: string }).method;
      if (method === "agent.wait") {
        return {
          status: "ok",
          startedAt: 1000,
          endedAt: 2000,
        };
      }
      return {};
    });
  });

  afterEach(async () => {
    mod.resetSubagentRegistryForTests({ persist: false });
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  async function setupRunResultPath(runId: string): Promise<string> {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-result-gate-"));
    mocks.stateDir = tempDir;
    const resultPath = path.join(tempDir, "projects", "project-foo", "runs", runId, "result.json");
    await fs.mkdir(path.dirname(resultPath), { recursive: true });
    return resultPath;
  }

  it("fails deterministically with missing_result_json when result artifact is absent", async () => {
    const runId = "run-child-missing";
    const resultPath = await setupRunResultPath(runId);
    await fs.rm(resultPath, { force: true });

    mod.registerSubagentRun({
      runId,
      parentRunId: "run-parent-1",
      childSessionKey: "agent:main:subagent:child-missing",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      projectStem: "project-foo",
      epochId: 3,
      resultPath,
      required: true,
      task: "child task",
      cleanup: "keep",
    });

    await vi.waitFor(() => {
      expect(mod.getSubagentRunById(runId)?.state).toBe("terminal");
    });

    const run = mod.getSubagentRunById(runId);
    expect(run?.terminalStatus).toBe("failed");
    expect(run?.outcome).toEqual({
      status: "error",
      error: "missing_result_json",
    });
  });

  it("accepts completion only after valid result artifact validation", async () => {
    const runId = "run-child-valid";
    const resultPath = await setupRunResultPath(runId);
    await fs.writeFile(
      resultPath,
      JSON.stringify({
        status: "done",
        finishedAt: "2026-02-24T00:00:00.000Z",
        summary: ["done"],
        outputs: ["/tmp/output.txt"],
        project: "project-foo",
        epochId: 3,
        runId,
        parentRunId: "run-parent-2",
      }),
      "utf8",
    );

    mod.registerSubagentRun({
      runId,
      parentRunId: "run-parent-2",
      childSessionKey: "agent:main:subagent:child-valid",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      projectStem: "project-foo",
      epochId: 3,
      resultPath,
      required: true,
      task: "child task",
      cleanup: "keep",
    });

    await vi.waitFor(() => {
      expect(mod.getSubagentRunById(runId)?.state).toBe("terminal");
    });

    const run = mod.getSubagentRunById(runId);
    expect(run?.terminalStatus).toBe("done");
    expect(run?.outcome).toEqual({
      status: "ok",
    });
  });
});
