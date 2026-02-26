import { describe, expect, it } from "vitest";
import type { MsgContext } from "../auto-reply/templating.js";
import { resolveAgentOrchInboundContext, resolveAgentOrchOutboundContext } from "./routing.js";

describe("agent-orch-v1/routing", () => {
  it("strips leading # from Zulip stream names", () => {
    const ctx: MsgContext = {
      OriginatingChannel: "zulip",
      GroupChannel: "#00-control",
      MessageThreadId: "project-foo",
      MessageSid: "123",
      SenderId: "42",
      SenderTag: "human",
    };

    const resolved = resolveAgentOrchInboundContext(ctx);
    expect(resolved?.channel).toBe("zulip");
    expect(resolved?.streamName).toBe("00-control");
    expect(resolved?.topic).toBe("project-foo");
  });

  it("parses canonical stream targets for outbound context", () => {
    const resolved = resolveAgentOrchOutboundContext({
      channel: "zulip",
      to: "stream:00-control:autonomous-bits-3",
    });
    expect(resolved?.streamName).toBe("00-control");
    expect(resolved?.topic).toBe("autonomous-bits-3");
  });

  it("prefers explicit threadId over parsed topic when provided", () => {
    const resolved = resolveAgentOrchOutboundContext({
      channel: "zulip",
      to: "zulip:stream:00-control:stale-topic",
      threadId: "project-foo",
    });
    expect(resolved?.streamName).toBe("00-control");
    expect(resolved?.topic).toBe("project-foo");
  });
});
