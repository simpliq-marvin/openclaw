import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveAgentOrchV1Config } from "./config.js";
import type { AgentOrchResolvedProject } from "./project.js";
import {
  appendAgentOrchProjectEvent,
  isAgentOrchProjectSuppressed,
  isAgentOrchRunFenced,
  loadAgentOrchProjectState,
  markAgentOrchLaneActivity,
} from "./store.js";
import type { AgentOrchOutboundContext } from "./types.js";

const log = createSubsystemLogger("agent-orch-v1/gate");

export type AgentOrchOutboundGateDecision = {
  allow: boolean;
  reason?: string;
  code?: "stale_epoch_dropped";
};

export function evaluateAgentOrchOutboundGate(params: {
  cfg: OpenClawConfig;
  context: AgentOrchOutboundContext;
  project: AgentOrchResolvedProject | null;
}): AgentOrchOutboundGateDecision {
  const resolved = resolveAgentOrchV1Config(params.cfg);
  if (!resolved.enabled) {
    return { allow: true };
  }
  if (!params.project) {
    return { allow: true };
  }
  const streamName = params.context.streamName?.trim();
  if (streamName && streamName === resolved.controlStream) {
    return { allow: true };
  }
  const state = loadAgentOrchProjectState(params.cfg, params.project.projectStem);
  if (
    params.context.runEpochId != null &&
    Number.isFinite(params.context.runEpochId) &&
    params.context.runEpochId !== state.epochId
  ) {
    appendAgentOrchProjectEvent(params.cfg, params.project.projectStem, {
      at: new Date().toISOString(),
      type: "outbound.dropped",
      data: {
        reason: "stale-epoch",
        runId: params.context.runId,
        runEpochId: params.context.runEpochId,
        currentEpochId: state.epochId,
        streamName: params.context.streamName,
        topic: params.context.topic,
      },
    });
    log.info(
      `epoch: dropped stale outbound project=${params.project.projectStem} runId=${params.context.runId ?? "unknown"} runEpoch=${params.context.runEpochId} currentEpoch=${state.epochId}`,
    );
    return { allow: false, reason: "stale-epoch", code: "stale_epoch_dropped" };
  }
  if (
    params.context.runId &&
    isAgentOrchRunFenced({
      cfg: params.cfg,
      projectStem: params.project.projectStem,
      runId: params.context.runId,
    })
  ) {
    appendAgentOrchProjectEvent(params.cfg, params.project.projectStem, {
      at: new Date().toISOString(),
      type: "outbound.dropped",
      data: {
        reason: "run-fenced",
        runId: params.context.runId,
        streamName: params.context.streamName,
        topic: params.context.topic,
      },
    });
    return { allow: false, reason: "run-fenced" };
  }
  if (isAgentOrchProjectSuppressed(state)) {
    appendAgentOrchProjectEvent(params.cfg, params.project.projectStem, {
      at: new Date().toISOString(),
      type: "outbound.dropped",
      data: {
        reason: state.halted ? "halted" : "closed",
        runId: params.context.runId,
        streamName: params.context.streamName,
        topic: params.context.topic,
      },
    });
    return { allow: false, reason: state.halted ? "halted" : "closed" };
  }
  markAgentOrchLaneActivity({
    cfg: params.cfg,
    projectStem: params.project.projectStem,
    streamName: params.project.streamName,
    streamId: params.project.streamId,
    topic: params.project.topic,
    laneRole: params.project.laneRole,
    laneInstance: params.project.laneInstance,
  });
  return { allow: true };
}
