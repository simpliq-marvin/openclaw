import { describe, expect, it } from "vitest";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveAgentOrchProjectFromInbound } from "./project.js";

function buildCfg(): OpenClawConfig {
  return {
    agentOrchV1: {
      enabled: true,
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
          strategist: {
            instances: {
              "1": {
                zulipStream: "02-flat-team-strategist",
              },
            },
          },
        },
      },
    },
  };
}

describe("agent-orch-v1 project resolver", () => {
  it("uses exact topic as project key and binds lane from topology stream", () => {
    const ctx = {
      Provider: "zulip",
      Surface: "zulip",
      OriginatingChannel: "zulip",
      GroupChannel: "02-flat-team-strategist",
      MessageThreadId: "Project Foo / Sprint 7",
      MessageSid: "mid-1",
      SenderUsername: "ian@simpliq.io",
    } as MsgContext;
    const resolved = resolveAgentOrchProjectFromInbound(ctx, buildCfg());
    expect(resolved?.project).toEqual({
      projectStem: "Project Foo / Sprint 7",
      laneRole: "strategist",
      laneInstance: 1,
      streamName: "02-flat-team-strategist",
      streamId: undefined,
      topic: "Project Foo / Sprint 7",
    });
  });

  it("returns null project when stream is not mapped in topology", () => {
    const ctx = {
      Provider: "zulip",
      Surface: "zulip",
      OriginatingChannel: "zulip",
      GroupChannel: "unmapped-stream",
      MessageThreadId: "project-foo",
    } as MsgContext;
    const resolved = resolveAgentOrchProjectFromInbound(ctx, buildCfg());
    expect(resolved?.project).toBeNull();
  });
});
