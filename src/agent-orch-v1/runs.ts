import path from "node:path";
import type { SubagentRunOutcome } from "../agents/subagent-announce.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveAgentOrchV1Config } from "./config.js";
import {
  appendAgentOrchProjectEvent,
  ensureAgentOrchProjectOrigin,
  loadAgentOrchProjectState,
} from "./store.js";
import type { AgentOrchRunTerminalStatus } from "./types.js";

export function resolveAgentOrchRunResultPath(params: {
  cfg: OpenClawConfig;
  projectStem: string;
  runId: string;
}): string {
  const resolved = resolveAgentOrchV1Config(params.cfg);
  return path.join(
    resolved.stateDir,
    "projects",
    params.projectStem,
    "runs",
    params.runId,
    "result.json",
  );
}

export function mapSubagentOutcomeToAgentOrchTerminalStatus(
  outcome?: SubagentRunOutcome,
): AgentOrchRunTerminalStatus {
  const status = outcome?.status;
  if (status === "ok") {
    return "done";
  }
  if (status === "timeout") {
    return "timeout";
  }
  if (status === "error") {
    const errorText = outcome?.error?.toLowerCase() ?? "";
    if (errorText.includes("blocked")) {
      return "blocked";
    }
    return "failed";
  }
  return "failed";
}

export function emitAgentOrchRunSpawnEvent(params: {
  cfg: OpenClawConfig;
  projectStem: string;
  runId: string;
  parentRunId?: string | null;
  epochId?: number;
  resultPath?: string;
  shortId?: string;
  requesterOrigin?: { streamName?: string; streamId?: string; topic?: string };
}): void {
  const state = loadAgentOrchProjectState(params.cfg, params.projectStem);
  if (params.requesterOrigin?.topic) {
    ensureAgentOrchProjectOrigin({
      cfg: params.cfg,
      projectStem: params.projectStem,
      origin: {
        streamName: params.requesterOrigin.streamName,
        streamId: params.requesterOrigin.streamId,
        topic: params.requesterOrigin.topic,
      },
    });
  }
  appendAgentOrchProjectEvent(params.cfg, params.projectStem, {
    at: new Date().toISOString(),
    type: "run.spawned",
    data: {
      runId: params.runId,
      parentRunId: params.parentRunId ?? null,
      epochId: params.epochId ?? state.epochId,
      resultPath: params.resultPath,
      shortId: params.shortId,
    },
  });
}

export function emitAgentOrchRunTerminalEvent(params: {
  cfg: OpenClawConfig;
  projectStem: string;
  runId: string;
  terminalStatus: AgentOrchRunTerminalStatus;
  hardKillSucceeded?: boolean;
}): void {
  appendAgentOrchProjectEvent(params.cfg, params.projectStem, {
    at: new Date().toISOString(),
    type: "run.terminal",
    data: {
      runId: params.runId,
      terminalStatus: params.terminalStatus,
      hardKillSucceeded: params.hardKillSucceeded,
    },
  });
}
