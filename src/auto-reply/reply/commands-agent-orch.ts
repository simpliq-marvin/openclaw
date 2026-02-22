import { canExecuteAgentOrchCommand } from "../../agent-orch-v1/authority.js";
import { resolveAgentOrchV1Config } from "../../agent-orch-v1/config.js";
import { parseAgentOrchControlCommand } from "../../agent-orch-v1/control-command.js";
import {
  parseAgentOrchControlTopicProject,
  resolveAgentOrchProjectFromInbound,
} from "../../agent-orch-v1/project.js";
import { emitAgentOrchRunTerminalEvent } from "../../agent-orch-v1/runs.js";
import {
  appendAgentOrchProjectEvent,
  closeAgentOrchProject,
  getAgentOrchControlDedupeEntry,
  listAgentOrchProjectLanes,
  loadAgentOrchProjectState,
  markAgentOrchRunFence,
  recordAgentOrchControlDedupeEntry,
  resolveAgentOrchExternalLatchState,
  setAgentOrchProjectHalted,
  unlatchAgentOrchProject,
} from "../../agent-orch-v1/store.js";
import { abortEmbeddedPiRun } from "../../agents/pi-embedded.js";
import {
  getSubagentRunById,
  listActiveSubagentRunsForProject,
  markSubagentRunTerminated,
} from "../../agents/subagent-registry.js";
import { loadSessionStore, resolveStorePath } from "../../config/sessions.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import type { CommandHandler, CommandHandlerResult } from "./commands-types.js";

function stopWithText(text: string): CommandHandlerResult {
  return {
    shouldContinue: false,
    reply: {
      text,
    },
  };
}

function formatSenderAudit(params: { email?: string; userId?: string; isBot: boolean }): string {
  const parts: string[] = [];
  if (params.email) {
    parts.push(`email=${params.email}`);
  }
  if (params.userId) {
    parts.push(`user_id=${params.userId}`);
  }
  parts.push(`is_bot=${params.isBot ? "true" : "false"}`);
  return parts.join(" ");
}

function tryAbortRunSession(params: {
  childSessionKey?: string;
  cfg: Parameters<CommandHandler>[0]["cfg"];
}): boolean {
  const childSessionKey = params.childSessionKey?.trim();
  if (!childSessionKey) {
    return false;
  }
  const parsed = parseAgentSessionKey(childSessionKey);
  const storePath = resolveStorePath(params.cfg.session?.store, { agentId: parsed?.agentId });
  const store = loadSessionStore(storePath);
  const sessionId = store[childSessionKey]?.sessionId;
  if (!sessionId) {
    return false;
  }
  return abortEmbeddedPiRun(sessionId);
}

function formatStatusResponse(params: {
  cfg: Parameters<CommandHandler>[0]["cfg"];
  projectStem: string;
}): string {
  const state = loadAgentOrchProjectState(params.cfg, params.projectStem);
  const externalState = resolveAgentOrchExternalLatchState(state);
  const activeRuns = listActiveSubagentRunsForProject(params.projectStem);
  const lines = [
    `project=${params.projectStem}`,
    `state=${externalState} epoch=${state.epochId} closedEpoch=${state.closedEpoch ?? "null"} halted=${state.halted ? "true" : "false"}`,
  ];
  if (state.origin?.topic) {
    const streamLabel = state.origin.streamName ?? state.origin.streamId ?? "<unknown>";
    lines.push(`origin=${streamLabel} topic=${state.origin.topic}`);
  } else {
    lines.push("origin=<unset>");
  }
  lines.push(`activeRuns=${activeRuns.length}`);
  for (const run of activeRuns.slice(0, 20)) {
    lines.push(
      `- ${run.shortId ?? "-----"} runId=${run.runId} state=${run.state ?? "running"} terminal=${run.terminalStatus ?? "n/a"}`,
    );
  }
  return lines.join("\n");
}

function formatListResponse(params: {
  cfg: Parameters<CommandHandler>[0]["cfg"];
  projectStem: string;
}): string {
  const lanes = listAgentOrchProjectLanes(params.cfg, params.projectStem);
  if (lanes.length === 0) {
    return `project=${params.projectStem}\nknown_lanes=0`;
  }
  const lines = [`project=${params.projectStem}`, `known_lanes=${lanes.length}`];
  for (const lane of lanes) {
    const streamLabel = lane.streamName ?? lane.streamId ?? "<unknown>";
    lines.push(
      `- ${streamLabel} :: ${lane.topic} role=${lane.laneRole} instance=${lane.laneInstance} last=${lane.lastActivityAt}`,
    );
  }
  return lines.join("\n");
}

function appendControlEvent(params: {
  cfg: Parameters<CommandHandler>[0]["cfg"];
  projectStem: string;
  command: string;
  reason?: string;
  senderEmail?: string;
  senderUserId?: string;
  senderIsBot: boolean;
  commandMessageId?: string;
  runId?: string;
  hardKillSucceeded?: boolean;
}): void {
  appendAgentOrchProjectEvent(params.cfg, params.projectStem, {
    at: new Date().toISOString(),
    type: "control.command",
    data: {
      command: params.command,
      reason: params.reason,
      runId: params.runId,
      hardKillSucceeded: params.hardKillSucceeded,
      senderEmail: params.senderEmail,
      senderUserId: params.senderUserId,
      senderIsBot: params.senderIsBot,
      messageId: params.commandMessageId,
    },
  });
}

export const handleAgentOrchCommand: CommandHandler = async (params) => {
  const resolved = resolveAgentOrchV1Config(params.cfg);
  const parsedCommand = parseAgentOrchControlCommand(params.command.commandBodyNormalized);
  if (parsedCommand.kind === "ignored") {
    return null;
  }
  if (!resolved.enabled) {
    return stopWithText("Agent orchestration v1 is disabled (agentOrchV1.enabled=false).");
  }
  const resolvedInbound = resolveAgentOrchProjectFromInbound(params.ctx, params.cfg);
  if (!resolvedInbound) {
    return stopWithText("`/oc` is currently supported only on Zulip.");
  }
  const inControlStream = resolvedInbound.context.streamName?.trim() === resolved.controlStream;
  if (!inControlStream) {
    return stopWithText(
      `\`/oc\` commands are only accepted in stream "${resolved.controlStream}".`,
    );
  }
  if (parsedCommand.kind === "invalid") {
    return stopWithText(parsedCommand.error);
  }

  const topicProject = parseAgentOrchControlTopicProject({
    cfg: params.cfg,
    topic: resolvedInbound.context.topic,
  });
  if (!topicProject) {
    return stopWithText("Control topic must be the canonical project stem.");
  }
  if (topicProject !== parsedCommand.project) {
    return stopWithText(
      `project mismatch: command project=${parsedCommand.project} but topic=${topicProject}`,
    );
  }

  const cached = getAgentOrchControlDedupeEntry({
    cfg: params.cfg,
    mid: resolvedInbound.context.messageId,
  });
  if (cached) {
    return stopWithText(cached.responseText);
  }

  const privilege = parsedCommand.name;
  const authorized = canExecuteAgentOrchCommand({
    privilege,
    identity: resolvedInbound.context.identity,
    inControlStream,
    config: resolved,
  });
  if (!authorized) {
    const text = `Unauthorized /oc ${parsedCommand.name}. (${formatSenderAudit({
      email: resolvedInbound.context.identity.senderEmail,
      userId: resolvedInbound.context.identity.senderUserId,
      isBot: resolvedInbound.context.identity.senderIsBot,
    })})`;
    recordAgentOrchControlDedupeEntry({
      cfg: params.cfg,
      mid: resolvedInbound.context.messageId,
      commandKey: parsedCommand.commandKey,
      responseText: text,
    });
    return stopWithText(text);
  }

  const reason = parsedCommand.args.reason?.trim();
  let responseText = "";
  if (parsedCommand.name === "halt") {
    const next = setAgentOrchProjectHalted({
      cfg: params.cfg,
      projectStem: parsedCommand.project,
      halted: true,
    });
    appendControlEvent({
      cfg: params.cfg,
      projectStem: parsedCommand.project,
      command: "halt",
      reason,
      senderEmail: resolvedInbound.context.identity.senderEmail,
      senderUserId: resolvedInbound.context.identity.senderUserId,
      senderIsBot: resolvedInbound.context.identity.senderIsBot,
      commandMessageId: resolvedInbound.context.messageId,
    });
    responseText = `HALTED project=${parsedCommand.project} epoch=${next.epochId}`;
  } else if (parsedCommand.name === "resume") {
    const next = setAgentOrchProjectHalted({
      cfg: params.cfg,
      projectStem: parsedCommand.project,
      halted: false,
    });
    appendControlEvent({
      cfg: params.cfg,
      projectStem: parsedCommand.project,
      command: "resume",
      reason,
      senderEmail: resolvedInbound.context.identity.senderEmail,
      senderUserId: resolvedInbound.context.identity.senderUserId,
      senderIsBot: resolvedInbound.context.identity.senderIsBot,
      commandMessageId: resolvedInbound.context.messageId,
    });
    responseText = `RESUMED project=${parsedCommand.project} epoch=${next.epochId}`;
  } else if (parsedCommand.name === "unlatch") {
    const next = unlatchAgentOrchProject({
      cfg: params.cfg,
      projectStem: parsedCommand.project,
    });
    appendControlEvent({
      cfg: params.cfg,
      projectStem: parsedCommand.project,
      command: "unlatch",
      reason,
      senderEmail: resolvedInbound.context.identity.senderEmail,
      senderUserId: resolvedInbound.context.identity.senderUserId,
      senderIsBot: resolvedInbound.context.identity.senderIsBot,
      commandMessageId: resolvedInbound.context.messageId,
    });
    responseText = `UNLATCHED project=${parsedCommand.project} epoch=${next.epochId}`;
  } else if (parsedCommand.name === "close") {
    const next = closeAgentOrchProject({
      cfg: params.cfg,
      projectStem: parsedCommand.project,
    });
    appendControlEvent({
      cfg: params.cfg,
      projectStem: parsedCommand.project,
      command: "close",
      reason,
      senderEmail: resolvedInbound.context.identity.senderEmail,
      senderUserId: resolvedInbound.context.identity.senderUserId,
      senderIsBot: resolvedInbound.context.identity.senderIsBot,
      commandMessageId: resolvedInbound.context.messageId,
    });
    responseText = `CLOSED project=${parsedCommand.project} closedEpoch=${next.closedEpoch ?? "null"}`;
  } else if (parsedCommand.name === "status") {
    responseText = formatStatusResponse({
      cfg: params.cfg,
      projectStem: parsedCommand.project,
    });
  } else if (parsedCommand.name === "list") {
    responseText = formatListResponse({
      cfg: params.cfg,
      projectStem: parsedCommand.project,
    });
  } else if (parsedCommand.name === "kill") {
    const runId = parsedCommand.args.runId?.trim();
    if (!runId) {
      responseText = "Missing runId=<uuid> argument.";
    } else {
      const run = getSubagentRunById(runId);
      const hardKillSucceeded = tryAbortRunSession({
        childSessionKey: run?.childSessionKey,
        cfg: params.cfg,
      });
      const cancelledCount = markSubagentRunTerminated({
        runId,
        reason: reason || "cancelled-by-oc-kill",
      });
      markAgentOrchRunFence({
        cfg: params.cfg,
        projectStem: parsedCommand.project,
        runId,
        reason: reason || "cancelled-by-oc-kill",
      });
      emitAgentOrchRunTerminalEvent({
        cfg: params.cfg,
        projectStem: parsedCommand.project,
        runId,
        terminalStatus: "cancelled",
        hardKillSucceeded,
      });
      appendControlEvent({
        cfg: params.cfg,
        projectStem: parsedCommand.project,
        command: "kill",
        reason,
        senderEmail: resolvedInbound.context.identity.senderEmail,
        senderUserId: resolvedInbound.context.identity.senderUserId,
        senderIsBot: resolvedInbound.context.identity.senderIsBot,
        commandMessageId: resolvedInbound.context.messageId,
        runId,
        hardKillSucceeded,
      });
      responseText =
        `KILL project=${parsedCommand.project} runId=${runId} cancelledCount=${cancelledCount} ` +
        `hardKillSucceeded=${hardKillSucceeded ? "true" : "false"}`;
    }
  }

  if (!responseText) {
    responseText = "No-op.";
  }
  recordAgentOrchControlDedupeEntry({
    cfg: params.cfg,
    mid: resolvedInbound.context.messageId,
    commandKey: parsedCommand.commandKey,
    responseText,
  });
  return stopWithText(responseText);
};
