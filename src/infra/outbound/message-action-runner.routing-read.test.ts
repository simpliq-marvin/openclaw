import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withTempHome } from "../../../test/helpers/temp-home.js";
import { startAgentOrchEpochFromKickoff } from "../../agent-orch-v1/store.js";
import { jsonResult } from "../../agents/tools/common.js";
import type { ChannelPlugin } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { runMessageAction } from "./message-action-runner.js";

type CapturedActionContext = {
  channel?: string;
  action?: string;
  params?: Record<string, unknown>;
};

let capturedActionCtx: CapturedActionContext | undefined;

const zulipPlugin: ChannelPlugin = {
  ...createOutboundTestPlugin({
    id: "zulip",
    capabilities: { chatTypes: ["direct", "group", "channel"] },
    outbound: {
      deliveryMode: "direct",
      sendText: async () => ({ channel: "zulip", messageId: "zulip-test" }),
    },
  }),
  messaging: {
    normalizeTarget: (raw: string) => raw.trim(),
    targetResolver: {
      looksLikeId: (raw: string) =>
        /^(?:zulip:)?(?:stream|channel|user):/i.test(raw.trim()) || raw.trim().startsWith("#"),
      hint: "Use zulip:stream:<stream> for stream targets.",
    },
  },
  actions: {
    listActions: () => ["read", "send"],
    handleAction: async (ctx) => {
      capturedActionCtx = {
        channel: ctx.channel,
        action: ctx.action,
        params: ctx.params,
      };
      return jsonResult({ ok: true, params: ctx.params });
    },
  },
};

function buildConfig(overrides?: Partial<OpenClawConfig>): OpenClawConfig {
  return {
    channels: {
      zulip: {
        enabled: true,
      },
    },
    agentOrchV1: {
      enabled: true,
      topology: {
        kind: "flat",
        roles: {
          engineer: {
            instances: {
              "1": {
                zulipStream: "03-flat-team-engineer",
              },
            },
          },
        },
      },
    },
    ...overrides,
  } as OpenClawConfig;
}

describe("runMessageAction route-aware read", () => {
  beforeEach(() => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "zulip",
          source: "test",
          plugin: zulipPlugin,
        },
      ]),
    );
    capturedActionCtx = undefined;
  });

  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
    capturedActionCtx = undefined;
  });

  it("resolves route envelope into Zulip stream/topic for read action", async () => {
    const cfg = buildConfig();
    const result = await runMessageAction({
      cfg,
      action: "read",
      params: {
        route: {
          project: "ft-project-001",
          role: "engineer",
          instance: 1,
        },
        limit: 10,
      } as never,
    });
    expect(result.kind).toBe("action");
    expect(capturedActionCtx?.channel).toBe("zulip");
    expect(capturedActionCtx?.action).toBe("read");
    expect(capturedActionCtx?.params?.to).toBe("zulip:stream:03-flat-team-engineer");
    expect(capturedActionCtx?.params?.threadId).toBe("ft-project-001");
  });

  it("applies kickoffMid epoch fence to route-aware reads by default", async () => {
    await withTempHome(async () => {
      const cfg = buildConfig();
      startAgentOrchEpochFromKickoff({
        cfg,
        projectStem: "ft-project-001",
        kickoffMid: "9001",
        streamName: "01-flat-team-orchestrator",
        topic: "ft-project-001",
        laneRole: "orchestrator",
        laneInstance: 1,
      });
      await runMessageAction({
        cfg,
        action: "read",
        params: {
          route: {
            project: "ft-project-001",
            role: "engineer",
            instance: 1,
          },
          limit: 5,
        } as never,
      });
      expect(capturedActionCtx?.params?.after).toBe("9001");
    });
  });

  it("preserves explicit after anchor when provided", async () => {
    await withTempHome(async () => {
      const cfg = buildConfig();
      startAgentOrchEpochFromKickoff({
        cfg,
        projectStem: "ft-project-001",
        kickoffMid: "9001",
        streamName: "01-flat-team-orchestrator",
        topic: "ft-project-001",
        laneRole: "orchestrator",
        laneInstance: 1,
      });
      await runMessageAction({
        cfg,
        action: "read",
        params: {
          route: {
            project: "ft-project-001",
            role: "engineer",
            instance: 1,
          },
          limit: 5,
          after: "9010",
        } as never,
      });
      expect(capturedActionCtx?.params?.after).toBe("9010");
    });
  });
});
