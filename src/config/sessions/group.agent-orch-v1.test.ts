import { describe, expect, it } from "vitest";
import { resolveGroupSessionKey } from "./group.js";

describe("resolveGroupSessionKey (agent-orch-v1)", () => {
  it("includes zulip topic in group key when MessageThreadId is present", () => {
    const base = resolveGroupSessionKey({
      Provider: "zulip",
      ChatType: "channel",
      From: "zulip:channel:987654",
    });
    const resolved = resolveGroupSessionKey({
      Provider: "zulip",
      ChatType: "channel",
      From: "zulip:channel:987654",
      MessageThreadId: "project-foo",
    });
    expect(base?.key).toBe("zulip:channel:zulip:channel:987654");
    expect(resolved?.key).toBe(`${base?.key}:topic:project-foo`);
  });

  it("keeps legacy behavior when no topic is present", () => {
    const resolved = resolveGroupSessionKey({
      Provider: "zulip",
      ChatType: "channel",
      From: "zulip:channel:987654",
    });
    expect(resolved?.key).toBe("zulip:channel:zulip:channel:987654");
  });
});
