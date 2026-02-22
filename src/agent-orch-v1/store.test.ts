import { describe, expect, it } from "vitest";
import { withTempHome } from "../../test/helpers/temp-home.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  closeAgentOrchProject,
  getAgentOrchControlDedupeEntry,
  loadAgentOrchProjectState,
  recordAgentOrchControlDedupeEntry,
  resolveAgentOrchExternalLatchState,
  setAgentOrchProjectHalted,
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
      expect(unlatched.epochId).toBeGreaterThan(1);
      expect(loadAgentOrchProjectState(cfg, stem).closedEpoch).toBeNull();
      expect(resolveAgentOrchExternalLatchState(resumed)).toBe("OPEN");
    });
  });
});
