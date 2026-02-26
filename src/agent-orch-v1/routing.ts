import type { MsgContext } from "../auto-reply/templating.js";
import type { ReplyPayload } from "../auto-reply/types.js";
import { normalizeMessageChannel } from "../utils/message-channel.js";
import type { AgentOrchInboundContext, AgentOrchOutboundContext } from "./types.js";

function safeString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeZulipStreamName(value: unknown): string | undefined {
  const raw = safeString(value);
  if (!raw) {
    return undefined;
  }
  // OpenClaw's Zulip templating sometimes prefixes stream names with '#'
  // (e.g. '#00-control'). Topology + control lane config use bare names.
  return raw.startsWith("#") ? raw.slice(1) : raw;
}

function normalizeChannelLabel(...values: Array<unknown>): string | undefined {
  for (const value of values) {
    const candidate = safeString(value);
    if (!candidate) {
      continue;
    }
    return normalizeMessageChannel(candidate) ?? candidate.toLowerCase();
  }
  return undefined;
}

function parseZulipAddress(raw?: string): {
  streamName?: string;
  streamId?: string;
  topic?: string;
} {
  const value = raw?.trim();
  if (!value) {
    return {};
  }
  let candidate = value;
  if (/^zulip:/i.test(candidate)) {
    candidate = candidate.slice("zulip:".length).trim();
  }
  if (!candidate) {
    return {};
  }
  if (/^(?:stream|channel):/i.test(candidate)) {
    candidate = candidate.slice(candidate.indexOf(":") + 1).trim();
  } else {
    return {};
  }
  let streamToken = candidate;
  let topic: string | undefined;
  const topicSuffix = /(?:^|\s)topic:\s*(.+)$/i.exec(candidate);
  if (topicSuffix) {
    streamToken = candidate.slice(0, topicSuffix.index).trim();
    topic = topicSuffix[1]?.trim() || undefined;
  } else {
    const colonIndex = candidate.indexOf(":");
    if (colonIndex > -1) {
      // Canonical format: stream:<stream>:<topic> (topic may contain ":").
      streamToken = candidate.slice(0, colonIndex).trim();
      topic = candidate.slice(colonIndex + 1).trim() || undefined;
    } else {
      const slashOrHash = candidate.search(/[/#]/);
      if (slashOrHash > -1) {
        streamToken = candidate.slice(0, slashOrHash).trim();
        topic = candidate.slice(slashOrHash + 1).trim() || undefined;
      }
    }
  }
  if (!streamToken) {
    return {};
  }
  const isNumericStream = /^[0-9]+$/.test(streamToken);
  return {
    streamName: isNumericStream ? undefined : streamToken,
    streamId: isNumericStream ? streamToken : undefined,
    topic,
  };
}

function resolveSenderEmail(ctx: MsgContext): string | undefined {
  const candidates = [
    ctx.SenderUsername,
    ctx.SenderId,
    ctx.From,
    ctx.SenderTag,
    ...(Array.isArray(ctx.UntrustedContext) ? ctx.UntrustedContext : []),
  ];
  for (const raw of candidates) {
    const value = safeString(raw);
    if (!value) {
      continue;
    }
    const emailMatch = value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi);
    if (emailMatch?.[0]) {
      return emailMatch[0].toLowerCase();
    }
  }
  return undefined;
}

function resolveSenderUserId(ctx: MsgContext): string | undefined {
  const senderId = safeString(ctx.SenderId);
  if (senderId && /^[0-9]+$/.test(senderId)) {
    return senderId;
  }
  const from = safeString(ctx.From);
  if (!from) {
    return undefined;
  }
  const numeric = from.match(/(^|:)([0-9]{2,})(:|$)/);
  return numeric?.[2];
}

function resolveSenderIsBot(ctx: MsgContext): boolean {
  const senderTag = safeString(ctx.SenderTag)?.toLowerCase() ?? "";
  if (senderTag.includes("bot")) {
    return true;
  }
  const senderUsername = safeString(ctx.SenderUsername)?.toLowerCase() ?? "";
  if (senderUsername.endsWith("-bot") || senderUsername.endsWith("_bot")) {
    return true;
  }
  const hints = Array.isArray(ctx.UntrustedContext) ? ctx.UntrustedContext : [];
  return hints.some((entry) => entry.toLowerCase().includes("is_bot=true"));
}

function resolveMessageId(ctx: MsgContext): string | undefined {
  return safeString(ctx.MessageSidFull) ?? safeString(ctx.MessageSid);
}

export function resolveAgentOrchInboundContext(ctx: MsgContext): AgentOrchInboundContext | null {
  const channel = normalizeChannelLabel(ctx.OriginatingChannel, ctx.Surface, ctx.Provider);
  if (channel !== "zulip") {
    return null;
  }
  const fromParsed = parseZulipAddress(safeString(ctx.From));
  const toParsed = parseZulipAddress(safeString(ctx.OriginatingTo) ?? safeString(ctx.To));
  const streamName =
    normalizeZulipStreamName(ctx.GroupChannel) ??
    normalizeZulipStreamName(ctx.GroupSubject) ??
    normalizeZulipStreamName(toParsed.streamName) ??
    normalizeZulipStreamName(fromParsed.streamName);
  const streamId = toParsed.streamId ?? fromParsed.streamId;
  const topic =
    safeString(ctx.MessageThreadId != null ? String(ctx.MessageThreadId) : undefined) ??
    safeString(ctx.ThreadLabel) ??
    toParsed.topic ??
    fromParsed.topic;
  return {
    channel,
    streamName,
    streamId,
    topic,
    messageId: resolveMessageId(ctx),
    identity: {
      senderEmail: resolveSenderEmail(ctx),
      senderUserId: resolveSenderUserId(ctx),
      senderIsBot: resolveSenderIsBot(ctx),
    },
  };
}

function readChannelDataRecord(payload?: ReplyPayload): Record<string, unknown> | undefined {
  if (!payload?.channelData || typeof payload.channelData !== "object") {
    return undefined;
  }
  return payload.channelData;
}

function readNestedRecord(
  record: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  const value = record?.[key];
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function readRunIdFromPayload(payload?: ReplyPayload): string | undefined {
  const channelData = readChannelDataRecord(payload);
  const orch = readNestedRecord(channelData, "agentOrchV1");
  return safeString(orch?.runId);
}

function readRunEpochIdFromPayload(payload?: ReplyPayload): number | undefined {
  const channelData = readChannelDataRecord(payload);
  const orch = readNestedRecord(channelData, "agentOrchV1");
  const raw = orch?.epochId;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.max(1, Math.floor(raw));
  }
  if (typeof raw === "string" && /^[0-9]+$/.test(raw.trim())) {
    return Math.max(1, Number.parseInt(raw.trim(), 10));
  }
  return undefined;
}

export function resolveAgentOrchOutboundContext(params: {
  channel: string;
  to: string;
  threadId?: string | number | null;
  payload?: ReplyPayload;
}): AgentOrchOutboundContext | null {
  const channel = normalizeChannelLabel(params.channel);
  if (channel !== "zulip") {
    return null;
  }
  const channelData = readChannelDataRecord(params.payload);
  const zulipData = readNestedRecord(channelData, "zulip");
  const parsedTo = parseZulipAddress(params.to);
  const threadTopic =
    params.threadId != null && params.threadId !== "" ? String(params.threadId).trim() : undefined;
  const streamName =
    normalizeZulipStreamName(zulipData?.streamName) ??
    normalizeZulipStreamName(zulipData?.stream) ??
    normalizeZulipStreamName(zulipData?.channel) ??
    normalizeZulipStreamName(parsedTo.streamName);
  const streamId =
    safeString(zulipData?.streamId) ?? safeString(zulipData?.stream_id) ?? parsedTo.streamId;
  const topic =
    safeString(zulipData?.topic) ?? safeString(zulipData?.subject) ?? threadTopic ?? parsedTo.topic;

  return {
    channel,
    streamName,
    streamId,
    topic,
    runId: readRunIdFromPayload(params.payload),
    runEpochId: readRunEpochIdFromPayload(params.payload),
  };
}
