import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveAgentOrchV1Config } from "./config.js";
import {
  isAgentOrchOrchestratorLane,
  resolveAgentOrchLaneByRoleInstance,
  resolveAgentOrchLaneByZulipStream,
} from "./topology.js";

describe("agent-orch-v1 topology", () => {
  it("normalizes flat topology role/instance lane mapping", () => {
    const cfg: OpenClawConfig = {
      agentOrchV1: {
        topology: {
          kind: "flat",
          roles: {
            orchestrator: {
              instances: {
                "1": {
                  zulipStream: "01-flat-team-orchestrator",
                },
              },
            },
            engineer: {
              instances: {
                "2": {
                  zulipStream: "03-flat-team-engineer-2",
                },
              },
            },
          },
        },
      },
    };
    const resolved = resolveAgentOrchV1Config(cfg);
    expect(resolved.topology.source).toBe("topology");
    expect(resolved.topology.roleInstanceMap.get("orchestrator#1")).toBe(
      "01-flat-team-orchestrator",
    );
    expect(resolved.topology.roleInstanceMap.get("engineer#2")).toBe("03-flat-team-engineer-2");
    expect(
      resolveAgentOrchLaneByZulipStream({ cfg, streamName: "03-flat-team-engineer-2" }),
    ).toEqual({
      role: "engineer",
      instance: 2,
      zulipStream: "03-flat-team-engineer-2",
    });
  });

  it("falls back to legacy routing map when topology is absent", () => {
    const cfg: OpenClawConfig = {
      agentOrchV1: {
        routing: {
          zulip: {
            roleInstanceMap: {
              orchestrator: "01-flat-team-orchestrator",
              "engineer#2": "03-flat-team-engineer-2",
            },
          },
        },
      },
    };
    const resolved = resolveAgentOrchV1Config(cfg);
    expect(resolved.topology.source).toBe("legacy-routing");
    expect(resolveAgentOrchLaneByRoleInstance({ cfg, role: "orchestrator", instance: 1 })).toEqual({
      role: "orchestrator",
      instance: 1,
      zulipStream: "01-flat-team-orchestrator",
    });
    expect(resolveAgentOrchLaneByRoleInstance({ cfg, role: "engineer", instance: 2 })).toEqual({
      role: "engineer",
      instance: 2,
      zulipStream: "03-flat-team-engineer-2",
    });
  });

  it("prefers topology map over legacy routing map when both are present", () => {
    const cfg: OpenClawConfig = {
      agentOrchV1: {
        topology: {
          kind: "flat",
          roles: {
            engineer: {
              instances: {
                "1": {
                  zulipStream: "topology-engineer",
                },
              },
            },
          },
        },
        routing: {
          zulip: {
            roleInstanceMap: {
              engineer: "legacy-engineer",
            },
          },
        },
      },
    };
    expect(resolveAgentOrchLaneByRoleInstance({ cfg, role: "engineer", instance: 1 })).toEqual({
      role: "engineer",
      instance: 1,
      zulipStream: "topology-engineer",
    });
  });

  it("detects orchestrator#1 lane", () => {
    expect(isAgentOrchOrchestratorLane({ role: "orchestrator", instance: 1 })).toBe(true);
    expect(isAgentOrchOrchestratorLane({ role: "orchestrator", instance: 2 })).toBe(false);
  });
});
