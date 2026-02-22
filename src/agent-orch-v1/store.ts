import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import { loadJsonFile, saveJsonFile } from "../infra/json-file.js";
import { resolveAgentOrchV1Config } from "./config.js";
import type {
  AgentOrchControlDedupeEntry,
  AgentOrchExternalLatchState,
  AgentOrchProjectEvent,
  AgentOrchProjectLane,
  AgentOrchProjectOrigin,
  AgentOrchProjectState,
  AgentOrchProjectStatePatch,
} from "./types.js";

type PersistedControlDedupe = {
  version: 1;
  entries: AgentOrchControlDedupeEntry[];
};

const CONTROL_DEDUPE_VERSION = 1 as const;

function nowIso(): string {
  return new Date().toISOString();
}

function ensureDirectory(dir: string): void {
  if (fs.existsSync(dir)) {
    return;
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function resolveProjectsDir(cfg: OpenClawConfig): string {
  return path.join(resolveAgentOrchV1Config(cfg).stateDir, "projects");
}

function resolveProjectDir(cfg: OpenClawConfig, projectStem: string): string {
  return path.join(resolveProjectsDir(cfg), projectStem);
}

function resolveProjectJsonPath(cfg: OpenClawConfig, projectStem: string): string {
  return path.join(resolveProjectDir(cfg, projectStem), "project.json");
}

function resolveProjectEventsPath(cfg: OpenClawConfig, projectStem: string): string {
  return path.join(resolveProjectDir(cfg, projectStem), "events.jsonl");
}

function resolveControlDedupePath(cfg: OpenClawConfig): string {
  return path.join(resolveAgentOrchV1Config(cfg).stateDir, "control-dedupe.json");
}

function buildDefaultProjectState(projectStem: string): AgentOrchProjectState {
  return {
    projectStem,
    epochId: 1,
    closedEpoch: null,
    halted: false,
    lanes: {},
    runFences: {},
    updatedAt: nowIso(),
  };
}

function readProjectStateFromDisk(cfg: OpenClawConfig, projectStem: string): AgentOrchProjectState {
  const pathname = resolveProjectJsonPath(cfg, projectStem);
  const raw = loadJsonFile(pathname);
  if (!raw || typeof raw !== "object") {
    return buildDefaultProjectState(projectStem);
  }
  const typed = raw as Partial<AgentOrchProjectState>;
  return {
    projectStem,
    epochId:
      typeof typed.epochId === "number" && Number.isFinite(typed.epochId)
        ? Math.max(1, Math.floor(typed.epochId))
        : 1,
    closedEpoch:
      typeof typed.closedEpoch === "number" && Number.isFinite(typed.closedEpoch)
        ? Math.max(1, Math.floor(typed.closedEpoch))
        : null,
    halted: typed.halted === true,
    origin:
      typed.origin && typeof typed.origin === "object" && typeof typed.origin.topic === "string"
        ? {
            streamName:
              typeof typed.origin.streamName === "string" ? typed.origin.streamName : undefined,
            streamId: typeof typed.origin.streamId === "string" ? typed.origin.streamId : undefined,
            topic: typed.origin.topic,
            capturedAt:
              typeof typed.origin.capturedAt === "string" ? typed.origin.capturedAt : nowIso(),
          }
        : undefined,
    lanes: typed.lanes && typeof typed.lanes === "object" ? typed.lanes : {},
    runFences: typed.runFences && typeof typed.runFences === "object" ? typed.runFences : {},
    updatedAt: typeof typed.updatedAt === "string" ? typed.updatedAt : nowIso(),
  };
}

function writeProjectStateToDisk(
  cfg: OpenClawConfig,
  projectStem: string,
  state: AgentOrchProjectState,
): void {
  const pathname = resolveProjectJsonPath(cfg, projectStem);
  ensureDirectory(path.dirname(pathname));
  saveJsonFile(pathname, state);
}

function loadControlDedupe(cfg: OpenClawConfig): PersistedControlDedupe {
  const pathname = resolveControlDedupePath(cfg);
  const raw = loadJsonFile(pathname);
  if (!raw || typeof raw !== "object") {
    return { version: CONTROL_DEDUPE_VERSION, entries: [] };
  }
  const typed = raw as Partial<PersistedControlDedupe>;
  if (typed.version !== CONTROL_DEDUPE_VERSION || !Array.isArray(typed.entries)) {
    return { version: CONTROL_DEDUPE_VERSION, entries: [] };
  }
  const entries = typed.entries.filter(
    (entry): entry is AgentOrchControlDedupeEntry =>
      typeof entry?.mid === "string" &&
      typeof entry?.commandKey === "string" &&
      typeof entry?.responseText === "string" &&
      typeof entry?.processedAt === "string",
  );
  return { version: CONTROL_DEDUPE_VERSION, entries };
}

function saveControlDedupe(cfg: OpenClawConfig, persisted: PersistedControlDedupe): void {
  const pathname = resolveControlDedupePath(cfg);
  ensureDirectory(path.dirname(pathname));
  saveJsonFile(pathname, persisted);
}

function pruneControlDedupe(
  cfg: OpenClawConfig,
  entries: AgentOrchControlDedupeEntry[],
): AgentOrchControlDedupeEntry[] {
  const resolved = resolveAgentOrchV1Config(cfg);
  const now = Date.now();
  const ttlMs = resolved.dedupe.ttlSeconds * 1000;
  const fresh = entries.filter((entry) => {
    const at = Date.parse(entry.processedAt);
    if (!Number.isFinite(at)) {
      return false;
    }
    return now - at <= ttlMs;
  });
  if (fresh.length <= resolved.dedupe.maxEntries) {
    return fresh;
  }
  return fresh.slice(fresh.length - resolved.dedupe.maxEntries);
}

export function loadAgentOrchProjectState(
  cfg: OpenClawConfig,
  projectStem: string,
): AgentOrchProjectState {
  return readProjectStateFromDisk(cfg, projectStem);
}

export function saveAgentOrchProjectState(
  cfg: OpenClawConfig,
  projectStem: string,
  state: AgentOrchProjectState,
): void {
  const next: AgentOrchProjectState = { ...state, projectStem, updatedAt: nowIso() };
  writeProjectStateToDisk(cfg, projectStem, next);
}

export function updateAgentOrchProjectState(params: {
  cfg: OpenClawConfig;
  projectStem: string;
  patch: AgentOrchProjectStatePatch;
}): AgentOrchProjectState {
  const current = loadAgentOrchProjectState(params.cfg, params.projectStem);
  const next: AgentOrchProjectState = {
    ...current,
    ...params.patch,
    lanes: params.patch.lanes ?? current.lanes,
    runFences: params.patch.runFences ?? current.runFences,
    updatedAt: nowIso(),
  };
  saveAgentOrchProjectState(params.cfg, params.projectStem, next);
  return next;
}

export function resolveAgentOrchExternalLatchState(
  state: Pick<AgentOrchProjectState, "closedEpoch" | "halted">,
): AgentOrchExternalLatchState {
  if (state.halted) {
    return "HALTED";
  }
  if (state.closedEpoch != null) {
    return "CLOSED";
  }
  return "OPEN";
}

export function isAgentOrchProjectSuppressed(
  state: Pick<AgentOrchProjectState, "closedEpoch" | "halted">,
): boolean {
  const external = resolveAgentOrchExternalLatchState(state);
  return external === "CLOSED" || external === "HALTED";
}

export function appendAgentOrchProjectEvent(
  cfg: OpenClawConfig,
  projectStem: string,
  event: AgentOrchProjectEvent,
): void {
  const pathname = resolveProjectEventsPath(cfg, projectStem);
  ensureDirectory(path.dirname(pathname));
  const line = `${JSON.stringify(event)}\n`;
  fs.appendFileSync(pathname, line, { encoding: "utf8", mode: 0o600 });
}

export function ensureAgentOrchProjectOrigin(params: {
  cfg: OpenClawConfig;
  projectStem: string;
  origin: Omit<AgentOrchProjectOrigin, "capturedAt">;
}): AgentOrchProjectState {
  const current = loadAgentOrchProjectState(params.cfg, params.projectStem);
  if (current.origin) {
    return current;
  }
  const next = {
    ...current,
    origin: {
      ...params.origin,
      capturedAt: nowIso(),
    },
    updatedAt: nowIso(),
  };
  saveAgentOrchProjectState(params.cfg, params.projectStem, next);
  return next;
}

export function markAgentOrchLaneActivity(params: {
  cfg: OpenClawConfig;
  projectStem: string;
  streamName?: string;
  streamId?: string;
  topic: string;
  laneRole: string;
  laneInstance: number;
}): AgentOrchProjectState {
  const current = loadAgentOrchProjectState(params.cfg, params.projectStem);
  const laneKey = `${params.streamId ?? params.streamName ?? "stream"}|${params.topic}`;
  const lane: AgentOrchProjectLane = {
    streamName: params.streamName,
    streamId: params.streamId,
    topic: params.topic,
    laneRole: params.laneRole,
    laneInstance: params.laneInstance,
    lastActivityAt: nowIso(),
  };
  const next = {
    ...current,
    origin:
      current.origin ??
      ({
        streamName: params.streamName,
        streamId: params.streamId,
        topic: params.topic,
        capturedAt: nowIso(),
      } satisfies AgentOrchProjectOrigin),
    lanes: {
      ...current.lanes,
      [laneKey]: lane,
    },
    updatedAt: nowIso(),
  };
  saveAgentOrchProjectState(params.cfg, params.projectStem, next);
  return next;
}

export function setAgentOrchProjectHalted(params: {
  cfg: OpenClawConfig;
  projectStem: string;
  halted: boolean;
}): AgentOrchProjectState {
  const current = loadAgentOrchProjectState(params.cfg, params.projectStem);
  const next = {
    ...current,
    halted: params.halted,
    updatedAt: nowIso(),
  };
  saveAgentOrchProjectState(params.cfg, params.projectStem, next);
  return next;
}

export function closeAgentOrchProject(params: {
  cfg: OpenClawConfig;
  projectStem: string;
}): AgentOrchProjectState {
  const current = loadAgentOrchProjectState(params.cfg, params.projectStem);
  const next = {
    ...current,
    closedEpoch: current.epochId,
    updatedAt: nowIso(),
  };
  saveAgentOrchProjectState(params.cfg, params.projectStem, next);
  return next;
}

export function unlatchAgentOrchProject(params: {
  cfg: OpenClawConfig;
  projectStem: string;
}): AgentOrchProjectState {
  const current = loadAgentOrchProjectState(params.cfg, params.projectStem);
  const next = {
    ...current,
    epochId: current.epochId + 1,
    closedEpoch: null,
    updatedAt: nowIso(),
  };
  saveAgentOrchProjectState(params.cfg, params.projectStem, next);
  return next;
}

export function markAgentOrchRunFence(params: {
  cfg: OpenClawConfig;
  projectStem: string;
  runId: string;
  reason?: string;
}): AgentOrchProjectState {
  const current = loadAgentOrchProjectState(params.cfg, params.projectStem);
  const next = {
    ...current,
    runFences: {
      ...current.runFences,
      [params.runId]: {
        epochId: current.epochId,
        fencedAt: nowIso(),
        reason: params.reason,
      },
    },
    updatedAt: nowIso(),
  };
  saveAgentOrchProjectState(params.cfg, params.projectStem, next);
  return next;
}

export function isAgentOrchRunFenced(params: {
  cfg: OpenClawConfig;
  projectStem: string;
  runId?: string;
}): boolean {
  if (!params.runId) {
    return false;
  }
  const state = loadAgentOrchProjectState(params.cfg, params.projectStem);
  return Boolean(state.runFences[params.runId]);
}

export function listAgentOrchProjectLanes(
  cfg: OpenClawConfig,
  projectStem: string,
): AgentOrchProjectLane[] {
  return Object.values(loadAgentOrchProjectState(cfg, projectStem).lanes).toSorted((a, b) =>
    a.lastActivityAt.localeCompare(b.lastActivityAt),
  );
}

export function getAgentOrchControlDedupeEntry(params: {
  cfg: OpenClawConfig;
  mid?: string;
}): AgentOrchControlDedupeEntry | null {
  const mid = params.mid?.trim();
  if (!mid) {
    return null;
  }
  const persisted = loadControlDedupe(params.cfg);
  const pruned = pruneControlDedupe(params.cfg, persisted.entries);
  if (pruned.length !== persisted.entries.length) {
    saveControlDedupe(params.cfg, { version: CONTROL_DEDUPE_VERSION, entries: pruned });
  }
  return pruned.find((entry) => entry.mid === mid) ?? null;
}

export function recordAgentOrchControlDedupeEntry(params: {
  cfg: OpenClawConfig;
  mid?: string;
  commandKey: string;
  responseText: string;
}): void {
  const mid = params.mid?.trim();
  if (!mid) {
    return;
  }
  const persisted = loadControlDedupe(params.cfg);
  const entries = persisted.entries.filter((entry) => entry.mid !== mid);
  entries.push({
    mid,
    commandKey: params.commandKey,
    responseText: params.responseText,
    processedAt: nowIso(),
  });
  const pruned = pruneControlDedupe(params.cfg, entries);
  saveControlDedupe(params.cfg, { version: CONTROL_DEDUPE_VERSION, entries: pruned });
}
