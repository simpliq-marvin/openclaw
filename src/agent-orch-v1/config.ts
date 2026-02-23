import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import type { AgentOrchV1Config } from "../config/types.agent-orch.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

export const DEFAULT_AGENT_ORCH_V1_CONTROL_STREAM = "00-control";
export const DEFAULT_AGENT_ORCH_V1_PROJECT_STEM_REGEX = "^[a-z0-9-]+$";
export const DEFAULT_AGENT_ORCH_V1_HEARTBEAT_SECONDS = 300;
export const DEFAULT_AGENT_ORCH_V1_DEDUPE_TTL_SECONDS = 14 * 24 * 60 * 60;
export const DEFAULT_AGENT_ORCH_V1_DEDUPE_MAX_ENTRIES = 4096;
export const DEFAULT_AGENT_ORCH_V1_TOPOLOGY_KIND = "flat";
const DEFAULT_IAN_EMAIL = "ian@simpliq.io";
const log = createSubsystemLogger("agent-orch-v1/config");
let didWarnTopologyPrecedence = false;

type AgentOrchRoleInstanceBinding = {
  role: string;
  instance: number;
};

export type ResolvedAgentOrchV1Config = {
  enabled: boolean;
  stateDir: string;
  controlStream: string;
  projectStemRegex: RegExp;
  projectStemRegexSource: string;
  authority: {
    ianEmails: Set<string>;
    haltAllowlistEmails: Set<string>;
    haltAllowlistUserIds: Set<string>;
    haltAllowBotsInControlStream: boolean;
    closeAllowlistEmails: Set<string>;
    unlatchAllowlistEmails: Set<string>;
    resumeAllowlistEmails: Set<string>;
    killAllowlistEmails: Set<string>;
  };
  liveness: {
    heartbeatSeconds: number;
    emitStillRunning: boolean;
  };
  dedupe: {
    ttlSeconds: number;
    maxEntries: number;
  };
  topology: {
    kind: "flat";
    roleInstanceMap: Map<string, string>;
    streamRoleInstanceMap: Map<string, AgentOrchRoleInstanceBinding>;
    source: "topology" | "legacy-routing" | "none";
  };
  routing: {
    zulip: {
      roleInstanceMap: Map<string, string>;
    };
  };
};

export function buildAgentOrchRoleInstanceKey(role: string, instance: number): string | null {
  const normalizedRole = role.trim().toLowerCase();
  const normalizedInstance = Number.isFinite(instance) ? Math.floor(instance) : 0;
  if (!normalizedRole || normalizedInstance < 1) {
    return null;
  }
  return `${normalizedRole}#${normalizedInstance}`;
}

function normalizeEmailSet(values: string[] | undefined, fallback: string[] = []): Set<string> {
  const out = new Set<string>();
  for (const entry of [...(values ?? []), ...fallback]) {
    const normalized = entry.trim().toLowerCase();
    if (normalized) {
      out.add(normalized);
    }
  }
  return out;
}

function normalizeIdSet(values: string[] | undefined): Set<string> {
  const out = new Set<string>();
  for (const entry of values ?? []) {
    const normalized = entry.trim();
    if (normalized) {
      out.add(normalized);
    }
  }
  return out;
}

function parsePositiveInt(value: string | number | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const normalized = Math.floor(value);
    return normalized >= 1 ? normalized : null;
  }
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!/^[1-9][0-9]*$/.test(trimmed)) {
    return null;
  }
  return Number.parseInt(trimmed, 10);
}

function parseRoleInstanceToken(raw: string): AgentOrchRoleInstanceBinding | null {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) {
    return null;
  }
  const hash = trimmed.lastIndexOf("#");
  if (hash === -1) {
    return { role: trimmed, instance: 1 };
  }
  const role = trimmed.slice(0, hash).trim();
  const instance = parsePositiveInt(trimmed.slice(hash + 1));
  if (!role || instance == null) {
    return null;
  }
  return { role, instance };
}

function parseRoleInstanceKey(key: string): AgentOrchRoleInstanceBinding | null {
  const match = key.match(/^(.+)#([1-9][0-9]*)$/);
  if (!match?.[1] || !match[2]) {
    return null;
  }
  const role = match[1].trim().toLowerCase();
  const instance = Number.parseInt(match[2], 10);
  if (!role || !Number.isFinite(instance) || instance < 1) {
    return null;
  }
  return { role, instance };
}

function normalizeLegacyRoleInstanceMap(
  values: Record<string, string> | undefined,
): Map<string, string> {
  const out = new Map<string, string>();
  if (!values || typeof values !== "object") {
    return out;
  }
  for (const [tokenRaw, streamRaw] of Object.entries(values)) {
    const parsed = parseRoleInstanceToken(tokenRaw);
    if (!parsed) {
      continue;
    }
    const key = buildAgentOrchRoleInstanceKey(parsed.role, parsed.instance);
    if (!key) {
      continue;
    }
    const stream = streamRaw.trim();
    if (!key || !stream) {
      continue;
    }
    out.set(key, stream);
  }
  return out;
}

function normalizeTopologyRoleInstanceMap(raw: AgentOrchV1Config): Map<string, string> {
  const out = new Map<string, string>();
  const roles = raw.topology?.roles;
  if (!roles || typeof roles !== "object") {
    return out;
  }
  for (const [roleRaw, roleCfg] of Object.entries(roles)) {
    const role = roleRaw.trim().toLowerCase();
    if (!role || !roleCfg || typeof roleCfg !== "object") {
      continue;
    }
    const instances = roleCfg.instances;
    if (!instances || typeof instances !== "object") {
      continue;
    }
    for (const [instanceRaw, instanceCfg] of Object.entries(instances)) {
      const instance = parsePositiveInt(instanceRaw);
      const key = instance ? buildAgentOrchRoleInstanceKey(role, instance) : null;
      const stream = instanceCfg?.zulipStream?.trim();
      if (!key || !stream) {
        continue;
      }
      out.set(key, stream);
    }
  }
  return out;
}

function buildStreamRoleInstanceMap(
  roleInstanceMap: Map<string, string>,
): Map<string, AgentOrchRoleInstanceBinding> {
  const out = new Map<string, AgentOrchRoleInstanceBinding>();
  for (const [key, streamRaw] of roleInstanceMap.entries()) {
    const parsed = parseRoleInstanceKey(key);
    if (!parsed) {
      continue;
    }
    const normalizedStream = streamRaw.trim().toLowerCase();
    if (!normalizedStream) {
      continue;
    }
    out.set(normalizedStream, parsed);
  }
  return out;
}

function coercePositiveInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.floor(value));
}

function resolveProjectStemRegex(raw?: string): { regex: RegExp; source: string } {
  const source = raw?.trim() || DEFAULT_AGENT_ORCH_V1_PROJECT_STEM_REGEX;
  try {
    return { regex: new RegExp(source), source };
  } catch {
    return {
      regex: new RegExp(DEFAULT_AGENT_ORCH_V1_PROJECT_STEM_REGEX),
      source: DEFAULT_AGENT_ORCH_V1_PROJECT_STEM_REGEX,
    };
  }
}

export function getAgentOrchV1RawConfig(cfg: OpenClawConfig): AgentOrchV1Config {
  return cfg.agentOrchV1 ?? {};
}

export function resolveAgentOrchV1Config(cfg: OpenClawConfig): ResolvedAgentOrchV1Config {
  const raw = getAgentOrchV1RawConfig(cfg);
  const stateDir = raw.stateDir?.trim()
    ? path.resolve(raw.stateDir)
    : path.join(resolveStateDir(process.env), "state", "agent-orch-v1");
  const controlStream = raw.controlStream?.trim() || DEFAULT_AGENT_ORCH_V1_CONTROL_STREAM;
  const { regex: projectStemRegex, source: projectStemRegexSource } = resolveProjectStemRegex(
    raw.taxonomy?.projectStemRegex,
  );
  const ianEmails = normalizeEmailSet(raw.authority?.ianEmails, [DEFAULT_IAN_EMAIL]);
  const topologyRoleInstanceMap = normalizeTopologyRoleInstanceMap(raw);
  const legacyRoleInstanceMap = normalizeLegacyRoleInstanceMap(raw.routing?.zulip?.roleInstanceMap);
  if (
    !didWarnTopologyPrecedence &&
    topologyRoleInstanceMap.size > 0 &&
    legacyRoleInstanceMap.size > 0
  ) {
    didWarnTopologyPrecedence = true;
    log.warn("routing: topology roles are set; ignoring legacy routing.zulip.roleInstanceMap");
  }
  const usingTopology = topologyRoleInstanceMap.size > 0;
  const effectiveRoleInstanceMap = usingTopology ? topologyRoleInstanceMap : legacyRoleInstanceMap;
  const topologySource: ResolvedAgentOrchV1Config["topology"]["source"] = usingTopology
    ? "topology"
    : legacyRoleInstanceMap.size > 0
      ? "legacy-routing"
      : "none";

  return {
    enabled: raw.enabled === true,
    stateDir,
    controlStream,
    projectStemRegex,
    projectStemRegexSource,
    authority: {
      ianEmails,
      haltAllowlistEmails: normalizeEmailSet(raw.authority?.haltAllowlistEmails),
      haltAllowlistUserIds: normalizeIdSet(raw.authority?.haltAllowlistUserIds),
      haltAllowBotsInControlStream: raw.authority?.haltAllowBotsInControlStream === true,
      closeAllowlistEmails: normalizeEmailSet(raw.authority?.closeAllowlistEmails, [...ianEmails]),
      unlatchAllowlistEmails: normalizeEmailSet(raw.authority?.unlatchAllowlistEmails, [
        ...ianEmails,
      ]),
      resumeAllowlistEmails: normalizeEmailSet(raw.authority?.resumeAllowlistEmails, [
        ...ianEmails,
      ]),
      killAllowlistEmails: normalizeEmailSet(raw.authority?.killAllowlistEmails, [...ianEmails]),
    },
    liveness: {
      heartbeatSeconds: coercePositiveInt(
        raw.liveness?.heartbeatSeconds,
        DEFAULT_AGENT_ORCH_V1_HEARTBEAT_SECONDS,
      ),
      emitStillRunning: raw.liveness?.emitStillRunning !== false,
    },
    dedupe: {
      ttlSeconds: coercePositiveInt(
        raw.dedupe?.ttlSeconds,
        DEFAULT_AGENT_ORCH_V1_DEDUPE_TTL_SECONDS,
      ),
      maxEntries: coercePositiveInt(
        raw.dedupe?.maxEntries,
        DEFAULT_AGENT_ORCH_V1_DEDUPE_MAX_ENTRIES,
      ),
    },
    topology: {
      kind: DEFAULT_AGENT_ORCH_V1_TOPOLOGY_KIND,
      roleInstanceMap: effectiveRoleInstanceMap,
      streamRoleInstanceMap: buildStreamRoleInstanceMap(effectiveRoleInstanceMap),
      source: topologySource,
    },
    routing: {
      zulip: {
        roleInstanceMap: effectiveRoleInstanceMap,
      },
    },
  };
}
