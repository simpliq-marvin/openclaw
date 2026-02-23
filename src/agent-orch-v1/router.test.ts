import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { buildRoutingFailureFallbackMessage, resolveRouteSendPlan } from "./router.js";

function buildCfg(): OpenClawConfig {
  return {
    agentOrchV1: {
      routing: {
        zulip: {
          roleInstanceMap: {
            engineer: "engineering",
            "engineer#2": "engineering-2",
          },
        },
      },
    },
  };
}

describe("agent-orch-v1 routing router", () => {
  it("resolves a mapped route envelope to Zulip stream/topic", () => {
    const plan = resolveRouteSendPlan({
      cfg: buildCfg(),
      route: {
        project: "project-foo",
        role: "engineer#2",
      },
    });
    expect(plan).toEqual({
      kind: "resolved",
      channel: "zulip",
      target: "zulip:stream:engineering-2",
      threadId: "project-foo",
      envelope: {
        project: "project-foo",
        role: "engineer",
        instance: 2,
      },
    });
  });

  it("falls back to origin topic with diagnostic tag on unmapped role", () => {
    const plan = resolveRouteSendPlan({
      cfg: buildCfg(),
      route: {
        project: "project-foo",
        role: "qa",
      },
      origin: {
        channel: "zulip",
        stream: "origin-stream",
        topic: "project-foo",
      },
    });
    expect(plan.kind).toBe("fallback");
    if (plan.kind !== "fallback") {
      return;
    }
    expect(plan.target).toBe("zulip:stream:origin-stream");
    expect(plan.threadId).toBe("project-foo");
    expect(plan.diagnosticTag).toBe(
      "[routing-failure] reason=unmapped-role-instance project=project-foo role=qa instance=1",
    );
  });

  it("returns structured error when fallback origin is unavailable", () => {
    const plan = resolveRouteSendPlan({
      cfg: buildCfg(),
      route: {
        project: "project-foo",
      },
    });
    expect(plan).toEqual({
      kind: "error",
      payload: {
        ok: false,
        error: {
          code: "routing_origin_missing",
          message: "routing: origin context missing for routing fallback",
          reason: "missing-role",
          project: "project-foo",
          role: "unknown",
          instance: "1",
        },
      },
    });
  });

  it("sanitizes mentions in fallback echoed content", () => {
    const text = buildRoutingFailureFallbackMessage({
      diagnosticTag: "[routing-failure] reason=missing-role project=foo role=unknown instance=1",
      originalMessage: "ping @**all** now",
    });
    expect(text).toContain("[routing-failure]");
    expect(text).not.toContain("@**all**");
    expect(text).toContain("@\u200b**all**");
  });
});
