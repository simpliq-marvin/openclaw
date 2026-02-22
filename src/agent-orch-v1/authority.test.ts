import { describe, expect, it } from "vitest";
import { canExecuteAgentOrchCommand, isIanIdentity } from "./authority.js";
import type { ResolvedAgentOrchV1Config } from "./config.js";

const baseConfig: ResolvedAgentOrchV1Config = {
  enabled: true,
  stateDir: "/tmp/state",
  controlStream: "00-control",
  projectStemRegex: /^[a-z0-9-]+$/,
  projectStemRegexSource: "^[a-z0-9-]+$",
  authority: {
    ianEmails: new Set(["ian@simpliq.io"]),
    haltAllowlistEmails: new Set(["bot@example.com"]),
    haltAllowlistUserIds: new Set(["42"]),
    haltAllowBotsInControlStream: false,
    closeAllowlistEmails: new Set(["ian@simpliq.io"]),
    unlatchAllowlistEmails: new Set(["ian@simpliq.io"]),
    resumeAllowlistEmails: new Set(["ian@simpliq.io"]),
    killAllowlistEmails: new Set(["ian@simpliq.io"]),
  },
  liveness: {
    heartbeatSeconds: 300,
    emitStillRunning: true,
  },
  dedupe: {
    ttlSeconds: 3600,
    maxEntries: 32,
  },
};

describe("agent-orch-v1 authority", () => {
  it("recognizes Ian canonical email", () => {
    expect(
      isIanIdentity(
        {
          senderEmail: "ian@simpliq.io",
          senderIsBot: false,
        },
        baseConfig,
      ),
    ).toBe(true);
  });

  it("allows HALT for allowlisted bot identities", () => {
    const allowed = canExecuteAgentOrchCommand({
      privilege: "halt",
      inControlStream: true,
      config: baseConfig,
      identity: {
        senderEmail: "bot@example.com",
        senderUserId: "42",
        senderIsBot: true,
      },
    });
    expect(allowed).toBe(true);
  });

  it("rejects RESUME for non-Ian users", () => {
    const allowed = canExecuteAgentOrchCommand({
      privilege: "resume",
      inControlStream: true,
      config: baseConfig,
      identity: {
        senderEmail: "other@example.com",
        senderIsBot: false,
      },
    });
    expect(allowed).toBe(false);
  });
});
