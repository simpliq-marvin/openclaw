import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveAgentOrchV1Config } from "./config.js";

describe("agent-orch-v1 config resolution", () => {
  it("prefers control.zulipStream over legacy controlStream", () => {
    const cfg: OpenClawConfig = {
      agentOrchV1: {
        controlStream: "legacy-control",
        control: {
          zulipStream: "00-control",
        },
      },
    };
    const resolved = resolveAgentOrchV1Config(cfg);
    expect(resolved.control.zulipStream).toBe("00-control");
    expect(resolved.controlStream).toBe("00-control");
  });

  it("uses subagent polling defaults when omitted", () => {
    const resolved = resolveAgentOrchV1Config({});
    expect(resolved.subagents.pollIntervalMs).toBe(30_000);
    expect(resolved.subagents.resultTimeoutMs).toBe(20 * 60_000);
  });

  it("uses configured subagent polling values", () => {
    const cfg: OpenClawConfig = {
      agentOrchV1: {
        subagents: {
          pollIntervalMs: 5000,
          resultTimeoutMs: 90_000,
        },
      },
    };
    const resolved = resolveAgentOrchV1Config(cfg);
    expect(resolved.subagents.pollIntervalMs).toBe(5000);
    expect(resolved.subagents.resultTimeoutMs).toBe(90_000);
  });
});
