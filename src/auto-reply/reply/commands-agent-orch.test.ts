import { describe, expect, it } from "vitest";
import { withTempHome } from "../../../test/helpers/temp-home.js";
import { loadAgentOrchProjectState, setAgentOrchProjectHalted } from "../../agent-orch-v1/store.js";
import type { OpenClawConfig } from "../../config/config.js";
import { handleAgentOrchCommand } from "./commands-agent-orch.js";
import { buildCommandTestParams } from "./commands.test-harness.js";

function buildConfig(): OpenClawConfig {
  return {
    agentOrchV1: {
      enabled: true,
      control: {
        zulipStream: "00-control",
      },
      authority: {
        ianEmails: ["ian@simpliq.io"],
        closeAllowlistEmails: ["ian@simpliq.io"],
        unlatchAllowlistEmails: ["ian@simpliq.io"],
        resumeAllowlistEmails: ["ian@simpliq.io"],
        killAllowlistEmails: ["ian@simpliq.io"],
      },
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
        },
      },
    },
  };
}

describe("/oc command handler", () => {
  it("halts a project from control stream and persists state", async () => {
    await withTempHome(async () => {
      const cfg = buildConfig();
      const params = buildCommandTestParams(
        '/oc halt project=project-foo reason="halt test"',
        cfg,
        {
          Provider: "zulip",
          Surface: "zulip",
          OriginatingChannel: "zulip",
          GroupChannel: "00-control",
          MessageThreadId: "project-foo",
          SenderUsername: "ian@simpliq.io",
          MessageSid: "mid-1",
        },
      );
      const result = await handleAgentOrchCommand(params, true);
      expect(result?.reply?.text).toContain("HALTED project=project-foo");
      const state = loadAgentOrchProjectState(cfg, "project-foo");
      expect(state.halted).toBe(true);
    });
  });

  it("dedupes control command by message id", async () => {
    await withTempHome(async () => {
      const cfg = buildConfig();
      const ctx = {
        Provider: "zulip",
        Surface: "zulip",
        OriginatingChannel: "zulip",
        GroupChannel: "00-control",
        MessageThreadId: "project-foo",
        SenderUsername: "ian@simpliq.io",
        MessageSid: "mid-dedupe",
      } as const;
      const first = await handleAgentOrchCommand(
        buildCommandTestParams("/oc close project=project-foo", cfg, ctx),
        true,
      );
      const second = await handleAgentOrchCommand(
        buildCommandTestParams("/oc close project=project-foo", cfg, ctx),
        true,
      );
      expect(first?.reply?.text).toBe(second?.reply?.text);
    });
  });

  it("rejects privileged command for non-Ian sender", async () => {
    await withTempHome(async () => {
      const cfg = buildConfig();
      const params = buildCommandTestParams("/oc resume project=project-foo", cfg, {
        Provider: "zulip",
        Surface: "zulip",
        OriginatingChannel: "zulip",
        GroupChannel: "00-control",
        MessageThreadId: "project-foo",
        SenderUsername: "other@example.com",
        MessageSid: "mid-unauth",
      });
      const result = await handleAgentOrchCommand(params, true);
      expect(result?.reply?.text).toContain("Unauthorized /oc resume");
    });
  });

  it("starts a new epoch on authorized human message in orchestrator lane", async () => {
    await withTempHome(async () => {
      const cfg = buildConfig();
      const result = await handleAgentOrchCommand(
        buildCommandTestParams("kickoff now", cfg, {
          Provider: "zulip",
          Surface: "zulip",
          OriginatingChannel: "zulip",
          GroupChannel: "01-flat-team-orchestrator",
          MessageThreadId: "project-foo",
          SenderUsername: "ian@simpliq.io",
          MessageSid: "mid-kickoff",
        }),
        true,
      );
      expect(result).toBeNull();
      const state = loadAgentOrchProjectState(cfg, "project-foo");
      expect(state.epochId).toBe(1);
      expect(state.epochs["1"]?.kickoffMid).toBe("mid-kickoff");
    });
  });

  it("does not auto-start epoch from kickoff when project is HALTED", async () => {
    await withTempHome(async () => {
      const cfg = buildConfig();
      setAgentOrchProjectHalted({
        cfg,
        projectStem: "project-foo",
        halted: true,
      });
      const result = await handleAgentOrchCommand(
        buildCommandTestParams("kickoff now", cfg, {
          Provider: "zulip",
          Surface: "zulip",
          OriginatingChannel: "zulip",
          GroupChannel: "01-flat-team-orchestrator",
          MessageThreadId: "project-foo",
          SenderUsername: "ian@simpliq.io",
          MessageSid: "mid-kickoff-halted",
        }),
        true,
      );
      expect(result).toBeNull();
      const state = loadAgentOrchProjectState(cfg, "project-foo");
      expect(state.epochId).toBe(0);
      expect(state.epochs["1"]).toBeUndefined();
    });
  });
});
