import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import {
  buildRoutingFailureFallbackMessage,
  resolveRouteSendPlan,
  type RoutingOriginContext,
  type RoutingStructuredErrorPayload,
} from "../../agent-orch-v1/router.js";
import {
  appendAgentOrchProjectEvent,
  resolveAgentOrchActiveEpochKickoffMid,
} from "../../agent-orch-v1/store.js";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import {
  readNumberParam,
  readStringArrayParam,
  readStringParam,
} from "../../agents/tools/common.js";
import { parseReplyDirectives } from "../../auto-reply/reply/reply-directives.js";
import { dispatchChannelMessageAction } from "../../channels/plugins/message-actions.js";
import type {
  ChannelId,
  ChannelMessageActionName,
  ChannelThreadingToolContext,
} from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  loadSessionStore,
  parseSessionThreadInfo,
  resolveStorePath,
} from "../../config/sessions.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { deliveryContextFromSession } from "../../utils/delivery-context.js";
import {
  isDeliverableMessageChannel,
  normalizeMessageChannel,
  type GatewayClientMode,
  type GatewayClientName,
} from "../../utils/message-channel.js";
import { throwIfAborted } from "./abort.js";
import {
  listConfiguredMessageChannels,
  resolveMessageChannelSelection,
} from "./channel-selection.js";
import { applyTargetToParams } from "./channel-target.js";
import type { OutboundSendDeps } from "./deliver.js";
import {
  hydrateSendAttachmentParams,
  hydrateSetGroupIconParams,
  normalizeSandboxMediaList,
  normalizeSandboxMediaParams,
  parseButtonsParam,
  parseCardParam,
  parseComponentsParam,
  readBooleanParam,
  resolveSlackAutoThreadId,
  resolveTelegramAutoThreadId,
} from "./message-action-params.js";
import { actionHasTarget, actionRequiresTarget } from "./message-action-spec.js";
import type { MessagePollResult, MessageSendResult } from "./message.js";
import {
  applyCrossContextDecoration,
  buildCrossContextDecoration,
  type CrossContextDecoration,
  enforceCrossContextPolicy,
  shouldApplyCrossContextMarker,
} from "./outbound-policy.js";
import { executePollAction, executeSendAction } from "./outbound-send-service.js";
import { ensureOutboundSessionEntry, resolveOutboundSessionRoute } from "./outbound-session.js";
import { resolveChannelTarget, type ResolvedMessagingTarget } from "./target-resolver.js";
import { extractToolPayload } from "./tool-payload.js";

const log = createSubsystemLogger("outbound/message-action-runner");
const INTERNAL_ROUTE_PROJECT_KEY = "__agentOrchRouteProject";

export type MessageActionRunnerGateway = {
  url?: string;
  token?: string;
  timeoutMs?: number;
  clientName: GatewayClientName;
  clientDisplayName?: string;
  mode: GatewayClientMode;
};

function resolveAndApplyOutboundThreadId(
  params: Record<string, unknown>,
  ctx: {
    channel: ChannelId;
    to: string;
    toolContext?: ChannelThreadingToolContext;
    allowSlackAutoThread: boolean;
  },
): string | undefined {
  const threadId = readStringParam(params, "threadId");
  const slackAutoThreadId =
    ctx.allowSlackAutoThread && ctx.channel === "slack" && !threadId
      ? resolveSlackAutoThreadId({ to: ctx.to, toolContext: ctx.toolContext })
      : undefined;
  const telegramAutoThreadId =
    ctx.channel === "telegram" && !threadId
      ? resolveTelegramAutoThreadId({ to: ctx.to, toolContext: ctx.toolContext })
      : undefined;
  const resolved = threadId ?? slackAutoThreadId ?? telegramAutoThreadId;
  // Write auto-resolved threadId back into params so downstream dispatch
  // (plugin `readStringParam(params, "threadId")`) picks it up.
  if (resolved && !params.threadId) {
    params.threadId = resolved;
  }
  return resolved ?? undefined;
}

type RoutedErrorResult = {
  kind: "error";
  channel: ChannelId;
  action: "send";
  handledBy: "core";
  payload: RoutingStructuredErrorPayload;
  dryRun: boolean;
};

type ResolvedZulipOriginContext = RoutingOriginContext & {
  source: "inbound" | "session";
};

function toNonEmptyString(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const normalized = String(Math.trunc(value)).trim();
    return normalized || undefined;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

type ParsedZulipTarget =
  | { kind: "stream"; stream: string; topic?: string }
  | { kind: "user"; email: string };

function splitZulipStreamAndTopic(raw: string): { stream: string; topic?: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  let stream = trimmed;
  let topic: string | undefined;
  const topicSuffix = /(?:^|\s)topic:\s*(.+)$/i.exec(trimmed);
  if (topicSuffix) {
    stream = trimmed.slice(0, topicSuffix.index).trim();
    topic = topicSuffix[1]?.trim() || undefined;
  } else {
    const colonIndex = trimmed.indexOf(":");
    if (colonIndex > -1) {
      // Canonical form: stream:<stream>:<topic>, where topic may contain ":".
      stream = trimmed.slice(0, colonIndex).trim();
      topic = trimmed.slice(colonIndex + 1).trim() || undefined;
    } else {
      const sepIndex = trimmed.search(/[/#]/);
      if (sepIndex > -1) {
        stream = trimmed.slice(0, sepIndex).trim();
        topic = trimmed.slice(sepIndex + 1).trim() || undefined;
      }
    }
  }
  if (!stream) {
    return null;
  }
  return { stream, topic };
}

function parseZulipTarget(raw: string): ParsedZulipTarget | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  let value = trimmed;
  let hadProviderPrefix = false;
  if (/^zulip:/i.test(value)) {
    value = value.slice("zulip:".length).trim();
    hadProviderPrefix = true;
  }
  if (!value) {
    return null;
  }
  if (/^(?:user|dm):/i.test(value)) {
    const email = value.slice(value.indexOf(":") + 1).trim();
    return email ? { kind: "user", email } : null;
  }
  if (value.startsWith("@")) {
    const email = value.slice(1).trim();
    return email ? { kind: "user", email } : null;
  }
  if (value.startsWith("#")) {
    const parsed = splitZulipStreamAndTopic(value.slice(1));
    if (!parsed) {
      return null;
    }
    return { kind: "stream", stream: parsed.stream, topic: parsed.topic };
  }
  if (/^(?:stream|channel):/i.test(value)) {
    const parsed = splitZulipStreamAndTopic(value.slice(value.indexOf(":") + 1));
    if (!parsed) {
      return null;
    }
    return { kind: "stream", stream: parsed.stream, topic: parsed.topic };
  }
  if (hadProviderPrefix && !value.includes("@")) {
    // Preserve legacy "zulip:<id>" behavior as a DM target.
    return { kind: "user", email: value };
  }
  if (value.includes("@")) {
    return { kind: "user", email: value };
  }
  return { kind: "stream", stream: value };
}

function canonicalizeZulipTarget(params: {
  target: string;
  topicHint?: string;
  requireTopic: boolean;
}): string | undefined {
  const parsed = parseZulipTarget(params.target);
  if (!parsed) {
    return undefined;
  }
  if (parsed.kind === "user") {
    return `user:${parsed.email}`;
  }
  const topic = parsed.topic ?? params.topicHint;
  if (params.requireTopic && !topic) {
    throw new Error("Topic is required for Zulip stream sends.");
  }
  return topic ? `stream:${parsed.stream}:${topic}` : `stream:${parsed.stream}`;
}

function stripZulipTopicFields(args: Record<string, unknown>): void {
  delete args.threadId;
  delete args.topic;
  delete args.threadName;
}

function parseZulipStream(raw: unknown): string | undefined {
  const value = toNonEmptyString(raw);
  if (!value) {
    return undefined;
  }
  const parsed = parseZulipTarget(value);
  if (!parsed || parsed.kind !== "stream") {
    return undefined;
  }
  return parsed.stream;
}

function hasZulipTopicInTarget(target: string): boolean {
  const parsed = parseZulipTarget(target);
  if (!parsed || parsed.kind !== "stream") {
    return false;
  }
  return Boolean(parsed.topic);
}

function isLikelyZulipStreamTarget(target: unknown): target is string {
  const value = toNonEmptyString(target);
  if (!value) {
    return false;
  }
  const parsed = parseZulipTarget(value);
  return parsed?.kind === "stream";
}

function resolveInboundZulipOriginContext(
  toolContext?: ChannelThreadingToolContext,
): ResolvedZulipOriginContext | null {
  const provider = normalizeMessageChannel(toolContext?.currentChannelProvider);
  if (provider !== "zulip") {
    return null;
  }
  const stream = parseZulipStream(toolContext?.currentChannelId);
  const topic = toNonEmptyString(toolContext?.currentThreadTs);
  if (!stream || !topic) {
    return null;
  }
  return {
    channel: "zulip",
    stream,
    topic,
    source: "inbound",
  };
}

function resolveSessionZulipOriginContext(
  input: RunMessageActionParams,
): ResolvedZulipOriginContext | null {
  const sessionKey = input.sessionKey?.trim();
  if (!sessionKey) {
    return null;
  }
  try {
    const storePath = resolveStorePath(input.cfg.session?.store);
    const store = loadSessionStore(storePath);
    const { baseSessionKey } = parseSessionThreadInfo(sessionKey);
    const candidateKeys = [sessionKey];
    if (baseSessionKey && baseSessionKey !== sessionKey) {
      candidateKeys.push(baseSessionKey);
    }
    for (const key of candidateKeys) {
      const entry = store[key];
      if (!entry) {
        continue;
      }
      const delivery = deliveryContextFromSession(entry);
      const channel = normalizeMessageChannel(
        toNonEmptyString(entry.origin?.provider) ??
          toNonEmptyString(entry.origin?.surface) ??
          toNonEmptyString(delivery?.channel) ??
          toNonEmptyString(entry.channel) ??
          toNonEmptyString(entry.lastChannel),
      );
      if (channel !== "zulip") {
        continue;
      }
      const stream = parseZulipStream(
        toNonEmptyString(entry.origin?.to) ??
          toNonEmptyString(delivery?.to) ??
          toNonEmptyString(entry.lastTo),
      );
      const topic =
        toNonEmptyString(entry.origin?.threadId) ??
        toNonEmptyString(delivery?.threadId) ??
        toNonEmptyString(entry.lastThreadId);
      if (!stream || !topic) {
        continue;
      }
      return {
        channel: "zulip",
        stream,
        topic,
        source: "session",
      };
    }
  } catch {
    // Best-effort origin recovery; ignore session read failures.
  }
  return null;
}

function resolveZulipOriginContext(
  input: RunMessageActionParams,
): ResolvedZulipOriginContext | null {
  return (
    resolveInboundZulipOriginContext(input.toolContext) ?? resolveSessionZulipOriginContext(input)
  );
}

function buildRoutingErrorResult(params: {
  payload: RoutingStructuredErrorPayload;
  dryRun: boolean;
}): RoutedErrorResult {
  return {
    kind: "error",
    channel: "zulip",
    action: "send",
    handledBy: "core",
    payload: params.payload,
    dryRun: params.dryRun,
  };
}

function maybeAliasZulipTopicParams(params: {
  action: ChannelMessageActionName;
  channel: ChannelId;
  args: Record<string, unknown>;
}): void {
  if (params.action !== "send" || params.channel !== "zulip") {
    return;
  }
  if (toNonEmptyString(params.args.threadId)) {
    return;
  }
  const topic = toNonEmptyString(params.args.topic) ?? toNonEmptyString(params.args.threadName);
  if (!topic) {
    return;
  }
  // Backwards-compat for callers that still use `topic`/`threadName` instead of `threadId`.
  params.args.threadId = topic;
  log.info(`routing: aliased topic param to threadId topic=${topic}`);
}

function maybeApplyRouteEnvelope(params: {
  input: RunMessageActionParams;
  args: Record<string, unknown>;
}): RoutedErrorResult | null {
  const action = params.input.action;
  if (action !== "send" && action !== "read") {
    return null;
  }
  const route = params.args.route;
  if (!route || typeof route !== "object" || Array.isArray(route)) {
    return null;
  }
  const origin = resolveZulipOriginContext(params.input);
  const plan = resolveRouteSendPlan({
    cfg: params.input.cfg,
    route,
    origin: origin ?? undefined,
  });
  if (plan.kind === "error") {
    if (action === "read") {
      throw new Error(
        `routing: read route resolution failed code=${plan.payload.error.code} reason=${plan.payload.error.reason}`,
      );
    }
    const projectStem = plan.payload.error.project.trim();
    if (projectStem && projectStem !== "unknown") {
      appendAgentOrchProjectEvent(params.input.cfg, projectStem, {
        at: new Date().toISOString(),
        type: "outbound.dropped",
        data: {
          reason: "routing_failure",
          code: plan.payload.error.code,
          routeReason: plan.payload.error.reason,
          role: plan.payload.error.role,
          instance: plan.payload.error.instance,
        },
      });
    }
    log.warn(
      `routing: origin missing for fallback reason=${plan.payload.error.reason} project=${plan.payload.error.project} role=${plan.payload.error.role} instance=${plan.payload.error.instance}`,
    );
    return buildRoutingErrorResult({
      payload: plan.payload,
      dryRun: Boolean(params.input.dryRun ?? readBooleanParam(params.args, "dryRun")),
    });
  }
  if (plan.kind === "resolved") {
    params.args.channel = plan.channel;
    params.args.target = plan.target;
    params.args.threadId = plan.threadId;
    params.args[INTERNAL_ROUTE_PROJECT_KEY] = plan.envelope.project;
    delete params.args.to;
    delete params.args.channelId;
    log.info(
      `routing: resolved project=${plan.envelope.project} role=${plan.envelope.role} instance=${plan.envelope.instance} target=${plan.target} topic=${plan.threadId}`,
    );
    return null;
  }

  if (action === "read") {
    throw new Error(
      `routing: read route resolution failed reason=${plan.reason} project=${plan.diagnostics.project} role=${plan.diagnostics.role} instance=${plan.diagnostics.instance}`,
    );
  } else {
    const originalMessage =
      typeof params.args.message === "string" ? params.args.message : undefined;
    params.args.channel = plan.channel;
    params.args.target = plan.target;
    params.args.threadId = plan.threadId;
    params.args.message = buildRoutingFailureFallbackMessage({
      diagnosticTag: plan.diagnosticTag,
      originalMessage,
    });
    delete params.args.to;
    delete params.args.channelId;
    log.warn(
      `routing: fallback reason=${plan.reason} target=${plan.target} topic=${plan.threadId} source=${origin?.source ?? "none"}`,
    );
  }
  return null;
}

function maybeApplyRouteReadEpochFence(params: {
  cfg: OpenClawConfig;
  action: ChannelMessageActionName;
  args: Record<string, unknown>;
}): void {
  const project = toNonEmptyString(params.args[INTERNAL_ROUTE_PROJECT_KEY]);
  delete params.args[INTERNAL_ROUTE_PROJECT_KEY];
  if (params.action !== "read" || !project) {
    return;
  }
  if (toNonEmptyString(params.args.after)) {
    return;
  }
  const activeEpoch = resolveAgentOrchActiveEpochKickoffMid({
    cfg: params.cfg,
    projectStem: project,
  });
  if (activeEpoch.epochId < 1 || !activeEpoch.kickoffMid) {
    return;
  }
  params.args.after = activeEpoch.kickoffMid;
  log.info(
    `epoch: applied read fence project=${project} epoch=${activeEpoch.epochId} kickoffMid=${activeEpoch.kickoffMid}`,
  );
}

function maybeApplyZulipTopicGuardrail(params: {
  input: RunMessageActionParams;
  action: ChannelMessageActionName;
  channel: ChannelId;
  args: Record<string, unknown>;
}): void {
  if (params.action !== "send" || params.channel !== "zulip") {
    return;
  }
  if (toNonEmptyString(params.args.threadId)) {
    return;
  }
  const target = toNonEmptyString(params.args.to);
  if (!target || !isLikelyZulipStreamTarget(target) || hasZulipTopicInTarget(target)) {
    return;
  }
  const origin = resolveZulipOriginContext(params.input);
  if (!origin) {
    return;
  }
  params.args.threadId = origin.topic;
  log.info(
    `routing: guardrail autofilled topic source=${origin.source} stream=${origin.stream} topic=${origin.topic}`,
  );
}

function maybeCanonicalizeZulipTarget(params: {
  action: ChannelMessageActionName;
  channel: ChannelId;
  args: Record<string, unknown>;
}): void {
  if (params.channel !== "zulip") {
    return;
  }
  if (params.action !== "send" && params.action !== "read" && params.action !== "search") {
    return;
  }
  const target = toNonEmptyString(params.args.to);
  if (!target) {
    return;
  }
  const topicHint =
    toNonEmptyString(params.args.threadId) ??
    toNonEmptyString(params.args.topic) ??
    toNonEmptyString(params.args.threadName);
  const canonical = canonicalizeZulipTarget({
    target,
    topicHint,
    requireTopic: params.action === "send",
  });
  if (!canonical) {
    return;
  }
  params.args.to = canonical;
  if (params.action !== "send") {
    stripZulipTopicFields(params.args);
  }
}

export type RunMessageActionParams = {
  cfg: OpenClawConfig;
  action: ChannelMessageActionName;
  params: Record<string, unknown>;
  defaultAccountId?: string;
  requesterSenderId?: string | null;
  toolContext?: ChannelThreadingToolContext;
  gateway?: MessageActionRunnerGateway;
  deps?: OutboundSendDeps;
  sessionKey?: string;
  agentId?: string;
  sandboxRoot?: string;
  dryRun?: boolean;
  abortSignal?: AbortSignal;
};

export type MessageActionRunResult =
  | {
      kind: "send";
      channel: ChannelId;
      action: "send";
      to: string;
      handledBy: "plugin" | "core";
      payload: unknown;
      toolResult?: AgentToolResult<unknown>;
      sendResult?: MessageSendResult;
      dryRun: boolean;
    }
  | {
      kind: "broadcast";
      channel: ChannelId;
      action: "broadcast";
      handledBy: "core" | "dry-run";
      payload: {
        results: Array<{
          channel: ChannelId;
          to: string;
          ok: boolean;
          error?: string;
          result?: MessageSendResult;
        }>;
      };
      dryRun: boolean;
    }
  | {
      kind: "poll";
      channel: ChannelId;
      action: "poll";
      to: string;
      handledBy: "plugin" | "core";
      payload: unknown;
      toolResult?: AgentToolResult<unknown>;
      pollResult?: MessagePollResult;
      dryRun: boolean;
    }
  | {
      kind: "action";
      channel: ChannelId;
      action: Exclude<ChannelMessageActionName, "send" | "poll">;
      handledBy: "plugin" | "dry-run";
      payload: unknown;
      toolResult?: AgentToolResult<unknown>;
      dryRun: boolean;
    }
  | RoutedErrorResult;

export function getToolResult(
  result: MessageActionRunResult,
): AgentToolResult<unknown> | undefined {
  return "toolResult" in result ? result.toolResult : undefined;
}

function applyCrossContextMessageDecoration({
  params,
  message,
  decoration,
  preferComponents,
}: {
  params: Record<string, unknown>;
  message: string;
  decoration: CrossContextDecoration;
  preferComponents: boolean;
}): string {
  const applied = applyCrossContextDecoration({
    message,
    decoration,
    preferComponents,
  });
  params.message = applied.message;
  if (applied.componentsBuilder) {
    params.components = applied.componentsBuilder;
  }
  return applied.message;
}

async function maybeApplyCrossContextMarker(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  action: ChannelMessageActionName;
  target: string;
  toolContext?: ChannelThreadingToolContext;
  accountId?: string | null;
  args: Record<string, unknown>;
  message: string;
  preferComponents: boolean;
}): Promise<string> {
  if (!shouldApplyCrossContextMarker(params.action) || !params.toolContext) {
    return params.message;
  }
  const decoration = await buildCrossContextDecoration({
    cfg: params.cfg,
    channel: params.channel,
    target: params.target,
    toolContext: params.toolContext,
    accountId: params.accountId ?? undefined,
  });
  if (!decoration) {
    return params.message;
  }
  return applyCrossContextMessageDecoration({
    params: params.args,
    message: params.message,
    decoration,
    preferComponents: params.preferComponents,
  });
}

async function resolveChannel(cfg: OpenClawConfig, params: Record<string, unknown>) {
  const channelHint = readStringParam(params, "channel");
  const selection = await resolveMessageChannelSelection({
    cfg,
    channel: channelHint,
  });
  return selection.channel;
}

async function resolveActionTarget(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  action: ChannelMessageActionName;
  args: Record<string, unknown>;
  accountId?: string | null;
}): Promise<ResolvedMessagingTarget | undefined> {
  let resolvedTarget: ResolvedMessagingTarget | undefined;
  const toRaw = typeof params.args.to === "string" ? params.args.to.trim() : "";
  if (toRaw) {
    const resolved = await resolveChannelTarget({
      cfg: params.cfg,
      channel: params.channel,
      input: toRaw,
      accountId: params.accountId ?? undefined,
    });
    if (resolved.ok) {
      params.args.to = resolved.target.to;
      resolvedTarget = resolved.target;
    } else {
      throw resolved.error;
    }
  }
  const channelIdRaw =
    typeof params.args.channelId === "string" ? params.args.channelId.trim() : "";
  if (channelIdRaw) {
    const resolved = await resolveChannelTarget({
      cfg: params.cfg,
      channel: params.channel,
      input: channelIdRaw,
      accountId: params.accountId ?? undefined,
      preferredKind: "group",
    });
    if (resolved.ok) {
      if (resolved.target.kind === "user") {
        throw new Error(`Channel id "${channelIdRaw}" resolved to a user target.`);
      }
      params.args.channelId = resolved.target.to.replace(/^(channel|group):/i, "");
    } else {
      throw resolved.error;
    }
  }
  return resolvedTarget;
}

type ResolvedActionContext = {
  cfg: OpenClawConfig;
  params: Record<string, unknown>;
  channel: ChannelId;
  accountId?: string | null;
  dryRun: boolean;
  gateway?: MessageActionRunnerGateway;
  input: RunMessageActionParams;
  agentId?: string;
  resolvedTarget?: ResolvedMessagingTarget;
  abortSignal?: AbortSignal;
};
function resolveGateway(input: RunMessageActionParams): MessageActionRunnerGateway | undefined {
  if (!input.gateway) {
    return undefined;
  }
  return {
    url: input.gateway.url,
    token: input.gateway.token,
    timeoutMs: input.gateway.timeoutMs,
    clientName: input.gateway.clientName,
    clientDisplayName: input.gateway.clientDisplayName,
    mode: input.gateway.mode,
  };
}

async function handleBroadcastAction(
  input: RunMessageActionParams,
  params: Record<string, unknown>,
): Promise<MessageActionRunResult> {
  throwIfAborted(input.abortSignal);
  const broadcastEnabled = input.cfg.tools?.message?.broadcast?.enabled !== false;
  if (!broadcastEnabled) {
    throw new Error("Broadcast is disabled. Set tools.message.broadcast.enabled to true.");
  }
  const rawTargets = readStringArrayParam(params, "targets", { required: true }) ?? [];
  if (rawTargets.length === 0) {
    throw new Error("Broadcast requires at least one target in --targets.");
  }
  const channelHint = readStringParam(params, "channel");
  const configured = await listConfiguredMessageChannels(input.cfg);
  if (configured.length === 0) {
    throw new Error("Broadcast requires at least one configured channel.");
  }
  const targetChannels =
    channelHint && channelHint.trim().toLowerCase() !== "all"
      ? [await resolveChannel(input.cfg, { channel: channelHint })]
      : configured;
  const results: Array<{
    channel: ChannelId;
    to: string;
    ok: boolean;
    error?: string;
    result?: MessageSendResult;
  }> = [];
  const isAbortError = (err: unknown): boolean => err instanceof Error && err.name === "AbortError";
  for (const targetChannel of targetChannels) {
    throwIfAborted(input.abortSignal);
    for (const target of rawTargets) {
      throwIfAborted(input.abortSignal);
      try {
        const resolved = await resolveChannelTarget({
          cfg: input.cfg,
          channel: targetChannel,
          input: target,
        });
        if (!resolved.ok) {
          throw resolved.error;
        }
        const sendResult = await runMessageAction({
          ...input,
          action: "send",
          params: {
            ...params,
            channel: targetChannel,
            target: resolved.target.to,
          },
        });
        if (sendResult.kind === "error") {
          results.push({
            channel: targetChannel,
            to: resolved.target.to,
            ok: false,
            error: `${sendResult.payload.error.code}: ${sendResult.payload.error.message}`,
          });
          continue;
        }
        results.push({
          channel: targetChannel,
          to: resolved.target.to,
          ok: true,
          result: sendResult.kind === "send" ? sendResult.sendResult : undefined,
        });
      } catch (err) {
        if (isAbortError(err)) {
          throw err;
        }
        results.push({
          channel: targetChannel,
          to: target,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  return {
    kind: "broadcast",
    channel: targetChannels[0] ?? "discord",
    action: "broadcast",
    handledBy: input.dryRun ? "dry-run" : "core",
    payload: { results },
    dryRun: Boolean(input.dryRun),
  };
}

async function handleSendAction(ctx: ResolvedActionContext): Promise<MessageActionRunResult> {
  const {
    cfg,
    params,
    channel,
    accountId,
    dryRun,
    gateway,
    input,
    agentId,
    resolvedTarget,
    abortSignal,
  } = ctx;
  throwIfAborted(abortSignal);
  const action: ChannelMessageActionName = "send";
  const to = readStringParam(params, "to", { required: true });
  // Support media, path, and filePath parameters for attachments
  const mediaHint =
    readStringParam(params, "media", { trim: false }) ??
    readStringParam(params, "path", { trim: false }) ??
    readStringParam(params, "filePath", { trim: false });
  const hasCard = params.card != null && typeof params.card === "object";
  const hasComponents = params.components != null && typeof params.components === "object";
  const caption = readStringParam(params, "caption", { allowEmpty: true }) ?? "";
  let message =
    readStringParam(params, "message", {
      required: !mediaHint && !hasCard && !hasComponents,
      allowEmpty: true,
    }) ?? "";
  if (message.includes("\\n")) {
    message = message.replaceAll("\\n", "\n");
  }
  if (!message.trim() && caption.trim()) {
    message = caption;
  }

  const parsed = parseReplyDirectives(message);
  const mergedMediaUrls: string[] = [];
  const seenMedia = new Set<string>();
  const pushMedia = (value?: string | null) => {
    const trimmed = value?.trim();
    if (!trimmed) {
      return;
    }
    if (seenMedia.has(trimmed)) {
      return;
    }
    seenMedia.add(trimmed);
    mergedMediaUrls.push(trimmed);
  };
  pushMedia(mediaHint);
  for (const url of parsed.mediaUrls ?? []) {
    pushMedia(url);
  }
  pushMedia(parsed.mediaUrl);

  const normalizedMediaUrls = await normalizeSandboxMediaList({
    values: mergedMediaUrls,
    sandboxRoot: input.sandboxRoot,
  });
  mergedMediaUrls.length = 0;
  mergedMediaUrls.push(...normalizedMediaUrls);

  message = parsed.text;
  params.message = message;
  if (!params.replyTo && parsed.replyToId) {
    params.replyTo = parsed.replyToId;
  }
  if (!params.media) {
    // Use path/filePath if media not set, then fall back to parsed directives
    params.media = mergedMediaUrls[0] || undefined;
  }

  message = await maybeApplyCrossContextMarker({
    cfg,
    channel,
    action,
    target: to,
    toolContext: input.toolContext,
    accountId,
    args: params,
    message,
    preferComponents: true,
  });

  const mediaUrl = readStringParam(params, "media", { trim: false });
  if (channel === "whatsapp") {
    message = message.replace(/^(?:[ \t]*\r?\n)+/, "");
    if (!message.trim()) {
      message = "";
    }
  }
  if (!message.trim() && !mediaUrl && mergedMediaUrls.length === 0 && !hasCard && !hasComponents) {
    throw new Error("send requires text or media");
  }
  params.message = message;
  const gifPlayback = readBooleanParam(params, "gifPlayback") ?? false;
  const bestEffort = readBooleanParam(params, "bestEffort");
  const silent = readBooleanParam(params, "silent");

  const replyToId = readStringParam(params, "replyTo");
  const resolvedThreadId = resolveAndApplyOutboundThreadId(params, {
    channel,
    to,
    toolContext: input.toolContext,
    allowSlackAutoThread: channel === "slack" && !replyToId,
  });
  const outboundRoute =
    agentId && !dryRun
      ? await resolveOutboundSessionRoute({
          cfg,
          channel,
          agentId,
          accountId,
          target: to,
          resolvedTarget,
          replyToId,
          threadId: resolvedThreadId,
        })
      : null;
  if (outboundRoute && agentId && !dryRun) {
    await ensureOutboundSessionEntry({
      cfg,
      agentId,
      channel,
      accountId,
      route: outboundRoute,
    });
  }
  if (outboundRoute && !dryRun) {
    params.__sessionKey = outboundRoute.sessionKey;
  }
  if (agentId) {
    params.__agentId = agentId;
  }
  const mirrorMediaUrls =
    mergedMediaUrls.length > 0 ? mergedMediaUrls : mediaUrl ? [mediaUrl] : undefined;
  const threadIdForSend =
    channel === "zulip"
      ? (() => {
          stripZulipTopicFields(params);
          return undefined;
        })()
      : (resolvedThreadId ?? undefined);
  throwIfAborted(abortSignal);
  const send = await executeSendAction({
    ctx: {
      cfg,
      channel,
      params,
      agentId,
      accountId: accountId ?? undefined,
      gateway,
      toolContext: input.toolContext,
      deps: input.deps,
      dryRun,
      mirror:
        outboundRoute && !dryRun
          ? {
              sessionKey: outboundRoute.sessionKey,
              agentId,
              text: message,
              mediaUrls: mirrorMediaUrls,
            }
          : undefined,
      abortSignal,
      silent: silent ?? undefined,
    },
    to,
    message,
    mediaUrl: mediaUrl || undefined,
    mediaUrls: mergedMediaUrls.length ? mergedMediaUrls : undefined,
    gifPlayback,
    bestEffort: bestEffort ?? undefined,
    replyToId: replyToId ?? undefined,
    threadId: threadIdForSend,
  });

  return {
    kind: "send",
    channel,
    action,
    to,
    handledBy: send.handledBy,
    payload: send.payload,
    toolResult: send.toolResult,
    sendResult: send.sendResult,
    dryRun,
  };
}

async function handlePollAction(ctx: ResolvedActionContext): Promise<MessageActionRunResult> {
  const { cfg, params, channel, accountId, dryRun, gateway, input, abortSignal } = ctx;
  throwIfAborted(abortSignal);
  const action: ChannelMessageActionName = "poll";
  const to = readStringParam(params, "to", { required: true });
  const question = readStringParam(params, "pollQuestion", {
    required: true,
  });
  const options = readStringArrayParam(params, "pollOption", { required: true }) ?? [];
  if (options.length < 2) {
    throw new Error("pollOption requires at least two values");
  }
  const silent = readBooleanParam(params, "silent");
  const allowMultiselect = readBooleanParam(params, "pollMulti") ?? false;
  const pollAnonymous = readBooleanParam(params, "pollAnonymous");
  const pollPublic = readBooleanParam(params, "pollPublic");
  if (pollAnonymous && pollPublic) {
    throw new Error("pollAnonymous and pollPublic are mutually exclusive");
  }
  const isAnonymous = pollAnonymous ? true : pollPublic ? false : undefined;
  const durationHours = readNumberParam(params, "pollDurationHours", {
    integer: true,
  });
  const durationSeconds = readNumberParam(params, "pollDurationSeconds", {
    integer: true,
  });
  const maxSelections = allowMultiselect ? Math.max(2, options.length) : 1;

  if (durationSeconds !== undefined && channel !== "telegram") {
    throw new Error("pollDurationSeconds is only supported for Telegram polls");
  }
  if (isAnonymous !== undefined && channel !== "telegram") {
    throw new Error("pollAnonymous/pollPublic are only supported for Telegram polls");
  }

  const resolvedThreadId = resolveAndApplyOutboundThreadId(params, {
    channel,
    to,
    toolContext: input.toolContext,
    allowSlackAutoThread: channel === "slack",
  });

  const base = typeof params.message === "string" ? params.message : "";
  await maybeApplyCrossContextMarker({
    cfg,
    channel,
    action,
    target: to,
    toolContext: input.toolContext,
    accountId,
    args: params,
    message: base,
    preferComponents: false,
  });

  const poll = await executePollAction({
    ctx: {
      cfg,
      channel,
      params,
      accountId: accountId ?? undefined,
      gateway,
      toolContext: input.toolContext,
      dryRun,
      silent: silent ?? undefined,
    },
    to,
    question,
    options,
    maxSelections,
    durationSeconds: durationSeconds ?? undefined,
    durationHours: durationHours ?? undefined,
    threadId: resolvedThreadId ?? undefined,
    isAnonymous,
  });

  return {
    kind: "poll",
    channel,
    action,
    to,
    handledBy: poll.handledBy,
    payload: poll.payload,
    toolResult: poll.toolResult,
    pollResult: poll.pollResult,
    dryRun,
  };
}

async function handlePluginAction(ctx: ResolvedActionContext): Promise<MessageActionRunResult> {
  const { cfg, params, channel, accountId, dryRun, gateway, input, abortSignal } = ctx;
  throwIfAborted(abortSignal);
  const action = input.action as Exclude<ChannelMessageActionName, "send" | "poll" | "broadcast">;
  if (dryRun) {
    return {
      kind: "action",
      channel,
      action,
      handledBy: "dry-run",
      payload: { ok: true, dryRun: true, channel, action },
      dryRun: true,
    };
  }

  const handled = await dispatchChannelMessageAction({
    channel,
    action,
    cfg,
    params,
    accountId: accountId ?? undefined,
    requesterSenderId: input.requesterSenderId ?? undefined,
    gateway,
    toolContext: input.toolContext,
    dryRun,
  });
  if (!handled) {
    throw new Error(`Message action ${action} not supported for channel ${channel}.`);
  }
  return {
    kind: "action",
    channel,
    action,
    handledBy: "plugin",
    payload: extractToolPayload(handled),
    toolResult: handled,
    dryRun,
  };
}

export async function runMessageAction(
  input: RunMessageActionParams,
): Promise<MessageActionRunResult> {
  const cfg = input.cfg;
  const params = { ...input.params };
  const resolvedAgentId =
    input.agentId ??
    (input.sessionKey
      ? resolveSessionAgentId({ sessionKey: input.sessionKey, config: cfg })
      : undefined);
  parseButtonsParam(params);
  parseCardParam(params);
  parseComponentsParam(params);

  const action = input.action;
  if (action === "broadcast") {
    return handleBroadcastAction(input, params);
  }
  const routedError = maybeApplyRouteEnvelope({ input, args: params });
  if (routedError) {
    return routedError;
  }

  const explicitTarget = typeof params.target === "string" ? params.target.trim() : "";
  const hasLegacyTarget =
    (typeof params.to === "string" && params.to.trim().length > 0) ||
    (typeof params.channelId === "string" && params.channelId.trim().length > 0);
  if (explicitTarget && hasLegacyTarget) {
    delete params.to;
    delete params.channelId;
  }
  if (
    !explicitTarget &&
    !hasLegacyTarget &&
    actionRequiresTarget(action) &&
    !actionHasTarget(action, params)
  ) {
    const inferredTarget = input.toolContext?.currentChannelId?.trim();
    if (inferredTarget) {
      params.target = inferredTarget;
    }
  }
  if (!explicitTarget && actionRequiresTarget(action) && hasLegacyTarget) {
    const legacyTo = typeof params.to === "string" ? params.to.trim() : "";
    const legacyChannelId = typeof params.channelId === "string" ? params.channelId.trim() : "";
    const legacyTarget = legacyTo || legacyChannelId;
    if (legacyTarget) {
      params.target = legacyTarget;
      delete params.to;
      delete params.channelId;
    }
  }
  const explicitChannel = typeof params.channel === "string" ? params.channel.trim() : "";
  if (!explicitChannel) {
    const inferredChannel = normalizeMessageChannel(input.toolContext?.currentChannelProvider);
    if (inferredChannel && isDeliverableMessageChannel(inferredChannel)) {
      params.channel = inferredChannel;
    }
  }

  applyTargetToParams({ action, args: params });
  if (actionRequiresTarget(action)) {
    if (!actionHasTarget(action, params)) {
      throw new Error(`Action ${action} requires a target.`);
    }
  }

  const channel = await resolveChannel(cfg, params);
  maybeAliasZulipTopicParams({ action, channel, args: params });
  maybeApplyRouteReadEpochFence({
    cfg,
    action,
    args: params,
  });
  maybeApplyZulipTopicGuardrail({
    input,
    action,
    channel,
    args: params,
  });
  const accountId = readStringParam(params, "accountId") ?? input.defaultAccountId;
  if (accountId) {
    params.accountId = accountId;
  }
  const dryRun = Boolean(input.dryRun ?? readBooleanParam(params, "dryRun"));

  await normalizeSandboxMediaParams({
    args: params,
    sandboxRoot: input.sandboxRoot,
  });

  await hydrateSendAttachmentParams({
    cfg,
    channel,
    accountId,
    args: params,
    action,
    dryRun,
  });

  await hydrateSetGroupIconParams({
    cfg,
    channel,
    accountId,
    args: params,
    action,
    dryRun,
  });

  const resolvedTarget = await resolveActionTarget({
    cfg,
    channel,
    action,
    args: params,
    accountId,
  });
  maybeCanonicalizeZulipTarget({
    action,
    channel,
    args: params,
  });

  enforceCrossContextPolicy({
    channel,
    action,
    args: params,
    toolContext: input.toolContext,
    cfg,
  });

  const gateway = resolveGateway(input);

  if (action === "send") {
    return handleSendAction({
      cfg,
      params,
      channel,
      accountId,
      dryRun,
      gateway,
      input,
      agentId: resolvedAgentId,
      resolvedTarget,
      abortSignal: input.abortSignal,
    });
  }

  if (action === "poll") {
    return handlePollAction({
      cfg,
      params,
      channel,
      accountId,
      dryRun,
      gateway,
      input,
      abortSignal: input.abortSignal,
    });
  }

  return handlePluginAction({
    cfg,
    params,
    channel,
    accountId,
    dryRun,
    gateway,
    input,
    abortSignal: input.abortSignal,
  });
}
