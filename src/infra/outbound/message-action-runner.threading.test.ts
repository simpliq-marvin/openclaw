import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { slackPlugin } from "../../../extensions/slack/src/channel.js";
import { telegramPlugin } from "../../../extensions/telegram/src/channel.js";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";

const mocks = vi.hoisted(() => ({
  executeSendAction: vi.fn(),
  recordSessionMetaFromInbound: vi.fn(async () => ({ ok: true })),
  loadSessionStore: vi.fn(() => ({})),
  resolveStorePath: vi.fn(() => "/tmp/openclaw-test-sessions.json"),
}));

vi.mock("./outbound-send-service.js", async () => {
  const actual = await vi.importActual<typeof import("./outbound-send-service.js")>(
    "./outbound-send-service.js",
  );
  return {
    ...actual,
    executeSendAction: mocks.executeSendAction,
  };
});

vi.mock("../../config/sessions.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/sessions.js")>(
    "../../config/sessions.js",
  );
  return {
    ...actual,
    recordSessionMetaFromInbound: mocks.recordSessionMetaFromInbound,
    loadSessionStore: mocks.loadSessionStore,
    resolveStorePath: mocks.resolveStorePath,
  };
});

import { runMessageAction } from "./message-action-runner.js";

const slackConfig = {
  channels: {
    slack: {
      botToken: "xoxb-test",
      appToken: "xapp-test",
    },
  },
} as OpenClawConfig;

const telegramConfig = {
  channels: {
    telegram: {
      botToken: "telegram-test",
    },
  },
} as OpenClawConfig;

const zulipConfig = {
  channels: {
    zulip: {
      enabled: true,
    },
  },
} as OpenClawConfig;

const routedZulipConfig = {
  ...zulipConfig,
  agentOrchV1: {
    routing: {
      zulip: {
        roleInstanceMap: {
          engineer: "eng-stream",
          "engineer#2": "eng-stream-2",
        },
      },
    },
  },
} as OpenClawConfig;

const zulipPlugin = {
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
      looksLikeId: (raw: string) => {
        const value = raw.trim();
        if (!value) {
          return false;
        }
        if (/^(?:zulip:)?(?:stream|channel|user):/i.test(value) || value.startsWith("#")) {
          return true;
        }
        // Mirror Zulip's common usage: bare stream names are treated as valid stream targets.
        if (!value.includes("@") && /^[a-z0-9][a-z0-9._-]{1,80}$/i.test(value)) {
          return true;
        }
        return false;
      },
      hint: "Use zulip:stream:<stream> for stream targets.",
    },
  },
};

async function runThreadingAction(params: {
  cfg: OpenClawConfig;
  actionParams: Record<string, unknown>;
  toolContext?: Record<string, unknown>;
  sessionKey?: string;
}) {
  const result = await runMessageAction({
    cfg: params.cfg,
    action: "send",
    params: params.actionParams as never,
    toolContext: params.toolContext as never,
    agentId: "main",
    sessionKey: params.sessionKey,
  });
  const call = mocks.executeSendAction.mock.calls[0]?.[0] as
    | {
        to?: string;
        threadId?: string;
        replyToId?: string;
        message?: string;
        ctx?: {
          agentId?: string;
          mirror?: { sessionKey?: string };
          params?: Record<string, unknown>;
        };
      }
    | undefined;
  return { result, call };
}

function mockHandledSendAction() {
  mocks.executeSendAction.mockResolvedValue({
    handledBy: "plugin",
    payload: {},
  });
}

const defaultTelegramToolContext = {
  currentChannelId: "telegram:123",
  currentThreadTs: "42",
} as const;

let createPluginRuntime: typeof import("../../plugins/runtime/index.js").createPluginRuntime;
let setSlackRuntime: typeof import("../../../extensions/slack/src/runtime.js").setSlackRuntime;
let setTelegramRuntime: typeof import("../../../extensions/telegram/src/runtime.js").setTelegramRuntime;

describe("runMessageAction threading auto-injection", () => {
  beforeAll(async () => {
    ({ createPluginRuntime } = await import("../../plugins/runtime/index.js"));
    ({ setSlackRuntime } = await import("../../../extensions/slack/src/runtime.js"));
    ({ setTelegramRuntime } = await import("../../../extensions/telegram/src/runtime.js"));
  });

  beforeEach(() => {
    const runtime = createPluginRuntime();
    setSlackRuntime(runtime);
    setTelegramRuntime(runtime);
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "slack",
          source: "test",
          plugin: slackPlugin,
        },
        {
          pluginId: "telegram",
          source: "test",
          plugin: telegramPlugin,
        },
        {
          pluginId: "zulip",
          source: "test",
          plugin: zulipPlugin,
        },
      ]),
    );
    mocks.loadSessionStore.mockReset();
    mocks.loadSessionStore.mockReturnValue({});
    mocks.resolveStorePath.mockReset();
    mocks.resolveStorePath.mockReturnValue("/tmp/openclaw-test-sessions.json");
  });

  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
    mocks.executeSendAction.mockReset();
    mocks.recordSessionMetaFromInbound.mockReset();
  });

  it.each([
    {
      name: "exact channel id",
      target: "channel:C123",
      threadTs: "111.222",
      expectedSessionKey: "agent:main:slack:channel:c123:thread:111.222",
    },
    {
      name: "case-insensitive channel id",
      target: "channel:c123",
      threadTs: "333.444",
      expectedSessionKey: "agent:main:slack:channel:c123:thread:333.444",
    },
  ] as const)("auto-threads slack using $name", async (testCase) => {
    mockHandledSendAction();

    const call = await runThreadingAction({
      cfg: slackConfig,
      actionParams: {
        channel: "slack",
        target: testCase.target,
        message: "hi",
      },
      toolContext: {
        currentChannelId: "C123",
        currentThreadTs: testCase.threadTs,
        replyToMode: "all",
      },
    });

    expect(call.call?.ctx?.agentId).toBe("main");
    expect(call.call?.ctx?.mirror?.sessionKey).toBe(testCase.expectedSessionKey);
  });

  it.each([
    {
      name: "injects threadId for matching target",
      target: "telegram:123",
      expectedThreadId: "42",
    },
    {
      name: "injects threadId for prefixed group target",
      target: "telegram:group:123",
      expectedThreadId: "42",
    },
    {
      name: "skips threadId when target chat differs",
      target: "telegram:999",
      expectedThreadId: undefined,
    },
  ] as const)("telegram auto-threading: $name", async (testCase) => {
    mockHandledSendAction();

    const call = await runThreadingAction({
      cfg: telegramConfig,
      actionParams: {
        channel: "telegram",
        target: testCase.target,
        message: "hi",
      },
      toolContext: defaultTelegramToolContext,
    });

    expect(call.call?.ctx?.params?.threadId).toBe(testCase.expectedThreadId);
    if (testCase.expectedThreadId !== undefined) {
      expect(call.call?.threadId).toBe(testCase.expectedThreadId);
    }
  });

  it("uses explicit telegram threadId when provided", async () => {
    mockHandledSendAction();

    const call = await runThreadingAction({
      cfg: telegramConfig,
      actionParams: {
        channel: "telegram",
        target: "telegram:123",
        message: "hi",
        threadId: "999",
      },
      toolContext: defaultTelegramToolContext,
    });

    expect(call.call?.threadId).toBe("999");
    expect(call.call?.ctx?.params?.threadId).toBe("999");
  });

  it("threads explicit replyTo through executeSendAction", async () => {
    mockHandledSendAction();

    const call = await runThreadingAction({
      cfg: telegramConfig,
      actionParams: {
        channel: "telegram",
        target: "telegram:123",
        message: "hi",
        replyTo: "777",
      },
      toolContext: defaultTelegramToolContext,
    });

    expect(call.call?.replyToId).toBe("777");
    expect(call.call?.ctx?.params?.replyTo).toBe("777");
  });

  it("resolves routed send to mapped Zulip stream/topic", async () => {
    mockHandledSendAction();

    const { call } = await runThreadingAction({
      cfg: routedZulipConfig,
      actionParams: {
        route: {
          project: "ft-project-001",
          role: "engineer#2",
        },
        message: "ship it",
      },
    });

    expect(call?.to).toBe("stream:eng-stream-2:ft-project-001");
    expect(call?.threadId).toBeUndefined();
    expect(call?.ctx?.params?.threadId).toBeUndefined();
    expect(call?.ctx?.params?.channel).toBe("zulip");
  });

  it("falls back to origin topic with sanitized diagnostics for unmapped route", async () => {
    mockHandledSendAction();

    const { call } = await runThreadingAction({
      cfg: routedZulipConfig,
      actionParams: {
        route: {
          project: "ft-project-001",
          role: "qa",
        },
        message: "ping @ops",
      },
      toolContext: {
        currentChannelProvider: "zulip",
        currentChannelId: "zulip:stream:origin-stream",
        currentThreadTs: "origin-topic",
      },
    });

    expect(call?.to).toBe("stream:origin-stream:origin-topic");
    expect(call?.threadId).toBeUndefined();
    expect(call?.ctx?.params?.threadId).toBeUndefined();
    expect(call?.message).toContain(
      "[routing-failure] reason=unmapped-role-instance project=ft-project-001 role=qa instance=1",
    );
    expect(call?.message).toContain("@\u200bops");
    expect(call?.message).not.toContain("@ops");
  });

  it("returns structured routing error when route fails without origin", async () => {
    mockHandledSendAction();

    const { result, call } = await runThreadingAction({
      cfg: routedZulipConfig,
      actionParams: {
        route: {
          project: "ft-project-001",
        },
        message: "hello",
      },
    });

    expect(call).toBeUndefined();
    expect(result).toEqual({
      kind: "error",
      action: "send",
      channel: "zulip",
      handledBy: "core",
      payload: {
        ok: false,
        error: {
          code: "routing_origin_missing",
          dropReason: "routing_failure",
          message: "routing: origin context missing for routing fallback",
          reason: "missing-role",
          project: "ft-project-001",
          role: "unknown",
          instance: "1",
        },
      },
      dryRun: false,
    });
  });

  it("canonicalizes separate Zulip topic into stream target", async () => {
    mockHandledSendAction();

    const { call } = await runThreadingAction({
      cfg: zulipConfig,
      actionParams: {
        channel: "zulip",
        target: "02-flat-team-strategist",
        topic: "ft-project-001",
        message: "hello",
      },
    });

    expect(call?.to).toBe("stream:02-flat-team-strategist:ft-project-001");
    expect(call?.threadId).toBeUndefined();
    expect(call?.ctx?.params?.threadId).toBeUndefined();
  });

  it("autofills missing Zulip topic from inbound origin context", async () => {
    mockHandledSendAction();

    const { call } = await runThreadingAction({
      cfg: zulipConfig,
      actionParams: {
        channel: "zulip",
        target: "zulip:stream:eng-stream",
        message: "hello",
      },
      toolContext: {
        currentChannelProvider: "zulip",
        currentChannelId: "zulip:stream:origin-stream",
        currentThreadTs: "origin-topic",
      },
    });

    expect(call?.to).toBe("stream:eng-stream:origin-topic");
    expect(call?.threadId).toBeUndefined();
    expect(call?.ctx?.params?.threadId).toBeUndefined();
  });

  it("autofills missing Zulip topic from session metadata when inbound context is absent", async () => {
    mockHandledSendAction();
    mocks.loadSessionStore.mockReturnValue({
      "agent:main:zulip:group:origin-stream": {
        sessionId: "session-1",
        updatedAt: Date.now(),
        origin: {
          provider: "zulip",
          to: "zulip:stream:session-origin-stream",
          threadId: "session-topic",
        },
      },
    });

    const { call } = await runThreadingAction({
      cfg: zulipConfig,
      sessionKey: "agent:main:zulip:group:origin-stream",
      actionParams: {
        channel: "zulip",
        target: "zulip:stream:eng-stream",
        message: "hello",
      },
    });

    expect(call?.to).toBe("stream:eng-stream:session-topic");
    expect(call?.threadId).toBeUndefined();
    expect(call?.ctx?.params?.threadId).toBeUndefined();
  });

  it("prefers inbound origin over session metadata for Zulip topic autofill", async () => {
    mockHandledSendAction();
    mocks.loadSessionStore.mockReturnValue({
      "agent:main:zulip:group:origin-stream": {
        sessionId: "session-1",
        updatedAt: Date.now(),
        origin: {
          provider: "zulip",
          to: "zulip:stream:session-origin-stream",
          threadId: "session-topic",
        },
      },
    });

    const { call } = await runThreadingAction({
      cfg: zulipConfig,
      sessionKey: "agent:main:zulip:group:origin-stream",
      actionParams: {
        channel: "zulip",
        target: "zulip:stream:eng-stream",
        message: "hello",
      },
      toolContext: {
        currentChannelProvider: "zulip",
        currentChannelId: "zulip:stream:origin-stream",
        currentThreadTs: "inbound-topic",
      },
    });

    expect(call?.to).toBe("stream:eng-stream:inbound-topic");
    expect(call?.threadId).toBeUndefined();
    expect(call?.ctx?.params?.threadId).toBeUndefined();
  });

  it("autofills missing Zulip topic for bare stream name targets", async () => {
    mockHandledSendAction();

    const { call } = await runThreadingAction({
      cfg: zulipConfig,
      actionParams: {
        channel: "zulip",
        target: "02-flat-team-strategist",
        message: "hello",
      },
      toolContext: {
        currentChannelProvider: "zulip",
        currentChannelId: "zulip:stream:origin-stream",
        currentThreadTs: "origin-topic",
      },
    });

    expect(call?.to).toBe("stream:02-flat-team-strategist:origin-topic");
    expect(call?.threadId).toBeUndefined();
    expect(call?.ctx?.params?.threadId).toBeUndefined();
  });
});
