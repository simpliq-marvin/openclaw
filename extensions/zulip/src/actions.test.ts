import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveZulipAccount: vi.fn(() => ({
    accountId: "default",
    apiKey: "test-key",
    email: "bot@example.com",
    baseUrl: "https://zulip.example.com",
    enableAdminActions: false,
    config: {},
  })),
  createZulipClient: vi.fn(() => ({}) as never),
  sendZulipStreamMessage: vi.fn(async () => ({ id: 101 })),
  sendZulipPrivateMessage: vi.fn(async () => ({ id: 202 })),
  fetchZulipMessages: vi.fn(async () => []),
  searchZulipMessages: vi.fn(async () => []),
}));

vi.mock("./zulip/accounts.js", async () => {
  const actual = await vi.importActual<typeof import("./zulip/accounts.js")>("./zulip/accounts.js");
  return {
    ...actual,
    resolveZulipAccount: mocks.resolveZulipAccount,
  };
});

vi.mock("./zulip/client.js", async () => {
  const actual = await vi.importActual<typeof import("./zulip/client.js")>("./zulip/client.js");
  return {
    ...actual,
    createZulipClient: mocks.createZulipClient,
    sendZulipStreamMessage: mocks.sendZulipStreamMessage,
    sendZulipPrivateMessage: mocks.sendZulipPrivateMessage,
    fetchZulipMessages: mocks.fetchZulipMessages,
    searchZulipMessages: mocks.searchZulipMessages,
  };
});

import { zulipMessageActions } from "./actions.js";

const cfg = {} as OpenClawConfig;

describe("zulipMessageActions target parsing", () => {
  beforeEach(() => {
    mocks.resolveZulipAccount.mockClear();
    mocks.createZulipClient.mockClear();
    mocks.sendZulipStreamMessage.mockClear();
    mocks.sendZulipPrivateMessage.mockClear();
    mocks.fetchZulipMessages.mockClear();
    mocks.searchZulipMessages.mockClear();
  });

  it("parses canonical stream target for send", async () => {
    await zulipMessageActions.handleAction({
      action: "send",
      params: {
        to: "stream:00-control:autonomous-bits-3",
        message: "hello",
      },
      cfg,
      accountId: "default",
      channel: "zulip",
      dryRun: false,
    });

    expect(mocks.sendZulipStreamMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        stream: "00-control",
        topic: "autonomous-bits-3",
        content: "hello",
      }),
    );
  });

  it("keeps topic remainder when canonical topic contains colon", async () => {
    await zulipMessageActions.handleAction({
      action: "send",
      params: {
        to: "stream:00-control:autonomous:bits-3",
        message: "hello",
      },
      cfg,
      accountId: "default",
      channel: "zulip",
      dryRun: false,
    });

    expect(mocks.sendZulipStreamMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        stream: "00-control",
        topic: "autonomous:bits-3",
      }),
    );
  });

  it("parses canonical stream target into read stream/topic narrow inputs", async () => {
    await zulipMessageActions.handleAction({
      action: "read",
      params: {
        to: "stream:00-control:autonomous-bits-3",
        limit: 5,
      },
      cfg,
      accountId: "default",
      channel: "zulip",
      dryRun: false,
    });

    expect(mocks.fetchZulipMessages).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        stream: "00-control",
        topic: "autonomous-bits-3",
        limit: 5,
      }),
    );
  });

  it("keeps legacy read formats working", async () => {
    await zulipMessageActions.handleAction({
      action: "read",
      params: {
        to: "zulip:stream:00-control/topic-legacy",
      },
      cfg,
      accountId: "default",
      channel: "zulip",
      dryRun: false,
    });

    expect(mocks.fetchZulipMessages).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        stream: "00-control",
        topic: "topic-legacy",
      }),
    );
  });
});
