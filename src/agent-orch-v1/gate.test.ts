import { describe, expect, it } from "vitest";
import { withTempHome } from "../../test/helpers/temp-home.js";
import type { OpenClawConfig } from "../config/config.js";
import { evaluateAgentOrchOutboundGate } from "./gate.js";
import { closeAgentOrchProject, markAgentOrchRunFence, unlatchAgentOrchProject } from "./store.js";

function buildCfg(): OpenClawConfig {
  return {
    agentOrchV1: {
      enabled: true,
      controlStream: "00-control",
    },
  };
}

describe("agent-orch-v1 outbound gate", () => {
  it("drops outbound for CLOSED projects", async () => {
    await withTempHome(async () => {
      const cfg = buildCfg();
      closeAgentOrchProject({ cfg, projectStem: "project-foo" });
      const decision = evaluateAgentOrchOutboundGate({
        cfg,
        context: {
          channel: "zulip",
          streamName: "engineering",
          topic: "project-foo",
        },
        project: {
          projectStem: "project-foo",
          laneRole: "engineering",
          laneInstance: 1,
          streamName: "engineering",
          topic: "project-foo",
        },
      });
      expect(decision).toEqual({
        allow: false,
        reason: "closed",
        dropReason: "closed",
        code: "closed_dropped",
      });
    });
  });

  it("drops outbound for fenced run ids", async () => {
    await withTempHome(async () => {
      const cfg = buildCfg();
      markAgentOrchRunFence({
        cfg,
        projectStem: "project-foo",
        runId: "run-1",
      });
      const decision = evaluateAgentOrchOutboundGate({
        cfg,
        context: {
          channel: "zulip",
          streamName: "engineering",
          topic: "project-foo",
          runId: "run-1",
        },
        project: {
          projectStem: "project-foo",
          laneRole: "engineering",
          laneInstance: 1,
          streamName: "engineering",
          topic: "project-foo",
        },
      });
      expect(decision).toEqual({
        allow: false,
        reason: "run-fenced",
        dropReason: "run_fenced",
        code: "run_fenced_dropped",
      });
    });
  });

  it("drops outbound for stale epoch run context", async () => {
    await withTempHome(async () => {
      const cfg = buildCfg();
      unlatchAgentOrchProject({ cfg, projectStem: "project-foo" });
      const decision = evaluateAgentOrchOutboundGate({
        cfg,
        context: {
          channel: "zulip",
          streamName: "engineering",
          topic: "project-foo",
          runId: "run-epoch-old",
          runEpochId: 0,
        },
        project: {
          projectStem: "project-foo",
          laneRole: "engineering",
          laneInstance: 1,
          streamName: "engineering",
          topic: "project-foo",
        },
      });
      expect(decision).toEqual({
        allow: false,
        reason: "stale-epoch",
        dropReason: "stale_epoch",
        code: "stale_epoch_dropped",
      });
    });
  });
});
