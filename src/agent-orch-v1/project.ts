import type { MsgContext } from "../auto-reply/templating.js";
import type { ReplyPayload } from "../auto-reply/types.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveAgentOrchV1Config } from "./config.js";
import { resolveAgentOrchInboundContext, resolveAgentOrchOutboundContext } from "./routing.js";
import { deriveLaneRoleFromStream, parseProjectTopic } from "./taxonomy.js";
import type {
  AgentOrchInboundContext,
  AgentOrchOutboundContext,
  AgentOrchParsedProjectTopic,
} from "./types.js";

export type AgentOrchResolvedProject = {
  projectStem: string;
  laneRole: string;
  laneInstance: number;
  streamName?: string;
  streamId?: string;
  topic: string;
};

function parseProjectFromTopic(params: {
  topic?: string;
  streamName?: string;
  cfg: OpenClawConfig;
}): AgentOrchParsedProjectTopic | null {
  const resolved = resolveAgentOrchV1Config(params.cfg);
  const laneRole = deriveLaneRoleFromStream(params.streamName);
  return parseProjectTopic({
    topic: params.topic,
    laneRole,
    projectStemRegex: resolved.projectStemRegex,
  });
}

function buildResolvedProject(
  parsed: AgentOrchParsedProjectTopic,
  context: AgentOrchInboundContext | AgentOrchOutboundContext,
): AgentOrchResolvedProject | null {
  const topic = context.topic?.trim();
  if (!topic) {
    return null;
  }
  return {
    projectStem: parsed.projectStem,
    laneRole: parsed.laneRole,
    laneInstance: parsed.laneInstance,
    streamName: context.streamName,
    streamId: context.streamId,
    topic,
  };
}

export function resolveAgentOrchProjectFromInbound(
  ctx: MsgContext,
  cfg: OpenClawConfig,
): { context: AgentOrchInboundContext; project: AgentOrchResolvedProject | null } | null {
  const context = resolveAgentOrchInboundContext(ctx);
  if (!context) {
    return null;
  }
  const parsed = parseProjectFromTopic({
    topic: context.topic,
    streamName: context.streamName,
    cfg,
  });
  return {
    context,
    project: parsed ? buildResolvedProject(parsed, context) : null,
  };
}

export function resolveAgentOrchProjectFromOutbound(params: {
  cfg: OpenClawConfig;
  channel: string;
  to: string;
  threadId?: string | number | null;
  payload?: ReplyPayload;
}): { context: AgentOrchOutboundContext; project: AgentOrchResolvedProject | null } | null {
  const context = resolveAgentOrchOutboundContext({
    channel: params.channel,
    to: params.to,
    threadId: params.threadId,
    payload: params.payload,
  });
  if (!context) {
    return null;
  }
  const parsed = parseProjectFromTopic({
    topic: context.topic,
    streamName: context.streamName,
    cfg: params.cfg,
  });
  return {
    context,
    project: parsed ? buildResolvedProject(parsed, context) : null,
  };
}

export function parseAgentOrchControlTopicProject(params: {
  cfg: OpenClawConfig;
  topic?: string;
}): string | null {
  const resolved = resolveAgentOrchV1Config(params.cfg);
  const trimmed = params.topic?.trim();
  if (!trimmed) {
    return null;
  }
  if (!resolved.projectStemRegex.test(trimmed)) {
    return null;
  }
  return trimmed;
}
