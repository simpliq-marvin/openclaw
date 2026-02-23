import type { OpenClawConfig } from "../config/config.js";
import { resolveAgentOrchV1Config } from "./config.js";

export type AgentOrchTopologyLane = {
  role: string;
  instance: number;
  zulipStream: string;
};

function normalizeRole(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeStream(value: string): string {
  return value.trim().toLowerCase();
}

export function resolveAgentOrchLaneByRoleInstance(params: {
  cfg: OpenClawConfig;
  role: string;
  instance: number;
}): AgentOrchTopologyLane | null {
  const role = normalizeRole(params.role);
  const instance = Number.isFinite(params.instance) ? Math.floor(params.instance) : 0;
  if (!role || instance < 1) {
    return null;
  }
  const key = `${role}#${instance}`;
  const stream = resolveAgentOrchV1Config(params.cfg).topology.roleInstanceMap.get(key);
  if (!stream) {
    return null;
  }
  return {
    role,
    instance,
    zulipStream: stream,
  };
}

export function resolveAgentOrchLaneByZulipStream(params: {
  cfg: OpenClawConfig;
  streamName?: string;
}): AgentOrchTopologyLane | null {
  const streamName = params.streamName?.trim();
  if (!streamName) {
    return null;
  }
  const resolved = resolveAgentOrchV1Config(params.cfg);
  const binding = resolved.topology.streamRoleInstanceMap.get(normalizeStream(streamName));
  if (!binding) {
    return null;
  }
  const key = `${binding.role}#${binding.instance}`;
  const mappedStream = resolved.topology.roleInstanceMap.get(key);
  if (!mappedStream) {
    return null;
  }
  return {
    role: binding.role,
    instance: binding.instance,
    zulipStream: mappedStream,
  };
}

export function isAgentOrchOrchestratorLane(params: { role: string; instance: number }): boolean {
  return normalizeRole(params.role) === "orchestrator" && params.instance === 1;
}
