import { describe, expect, it } from "vitest";
import { withTempHome } from "../../test/helpers/temp-home.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  closeAgentOrchProject,
  getAgentOrchControlDedupeEntry,
  loadAgentOrchProjectState,
  recordAgentOrchControlDedupeEntry,
  resolveAgentOrchActiveEpochKickoffMid,
  resolveAgentOrchExternalLatchState,
  setAgentOrchProjectHalted,
  startAgentOrchEpochFromKickoff,
  unlatchAgentOrchProject,
} from "./store.js";

function buildCfg(): OpenClawConfig {
  return {
    agentOrchV1: {
      enabled: true,
      controlStream: "00-control",
      dedupe: {
        ttlSeconds: 3600,
        maxEntries: 16,
      },
    },
  };
}

describe("agent-orch-v1 store", () => {
  it("persists control command dedupe by mid", async () => {
    await withTempHome(async () => {
      const cfg = buildCfg();
      recordAgentOrchControlDedupeEntry({
        cfg,
        mid: "123",
        commandKey: "halt project=project-foo",
        responseText: "HALTED",
      });
      const entry = getAgentOrchControlDedupeEntry({ cfg, mid: "123" });
      expect(entry?.responseText).toBe("HALTED");
    });
  });

  it("tracks CLOSED/HALTED/OPEN latch transitions", async () => {
    await withTempHome(async () => {
      const cfg = buildCfg();
      const stem = "project-foo";
      const closed = closeAgentOrchProject({ cfg, projectStem: stem });
      expect(resolveAgentOrchExternalLatchState(closed)).toBe("CLOSED");

      const halted = setAgentOrchProjectHalted({ cfg, projectStem: stem, halted: true });
      expect(resolveAgentOrchExternalLatchState(halted)).toBe("HALTED");

      const unlatched = unlatchAgentOrchProject({ cfg, projectStem: stem });
      const resumed = setAgentOrchProjectHalted({ cfg, projectStem: stem, halted: false });
      expect(unlatched.epochId).toBeGreaterThanOrEqual(1);
      expect(loadAgentOrchProjectState(cfg, stem).closedEpoch).toBeNull();
      expect(resolveAgentOrchExternalLatchState(resumed)).toBe("OPEN");
    });
  });

  it("starts a new epoch from kickoff message and records kickoff metadata", async () => {
    await withTempHome(async () => {
      const cfg = buildCfg();
      const started = startAgentOrchEpochFromKickoff({
        cfg,
        projectStem: "project-foo",
        kickoffMid: "87654321",
        streamName: "01-flat-team-orchestrator",
        topic: "project-foo",
        laneRole: "orchestrator",
        laneInstance: 1,
      });
      expect(started.started).toBe(true);
      expect(started.state.epochId).toBe(1);
      expect(started.state.epochs["1"]).toMatchObject({
        kickoffMid: "87654321",
      });
      expect(resolveAgentOrchActiveEpochKickoffMid({ cfg, projectStem: "project-foo" })).toEqual(
        expect.objectContaining({
          epochId: 1,
          kickoffMid: "87654321",
        }),
      );
    });
  });

  it("does not auto-start a new kickoff epoch while project is halted", async () => {
    await withTempHome(async () => {
      const cfg = buildCfg();
      setAgentOrchProjectHalted({
        cfg,
        projectStem: "project-foo",
        halted: true,
      });
      const started = startAgentOrchEpochFromKickoff({
        cfg,
        projectStem: "project-foo",
        kickoffMid: "999",
        streamName: "01-flat-team-orchestrator",
        topic: "project-foo",
        laneRole: "orchestrator",
        laneInstance: 1,
      });
      expect(started.started).toBe(false);
      expect(started.state.epochId).toBe(0);
      expect(Object.keys(started.state.epochs)).toHaveLength(0);
    });
  });
});
