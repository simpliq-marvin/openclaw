import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import type { AgentOrchV1Config } from "../config/types.agent-orch.js";

export const DEFAULT_AGENT_ORCH_V1_CONTROL_STREAM = "00-control";
export const DEFAULT_AGENT_ORCH_V1_PROJECT_STEM_REGEX = "^[a-z0-9-]+$";
export const DEFAULT_AGENT_ORCH_V1_HEARTBEAT_SECONDS = 300;
export const DEFAULT_AGENT_ORCH_V1_DEDUPE_TTL_SECONDS = 14 * 24 * 60 * 60;
export const DEFAULT_AGENT_ORCH_V1_DEDUPE_MAX_ENTRIES = 4096;
const DEFAULT_IAN_EMAIL = "ian@simpliq.io";

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
};

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
  };
}
