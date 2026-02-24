export type AgentOrchV1AuthorityConfig = {
  /** Canonical authority identities for Ian. */
  ianEmails?: string[];
  /** Explicit HALT email allowlist in addition to Ian identities. */
  haltAllowlistEmails?: string[];
  /** Optional HALT numeric user-id allowlist (stored as strings). */
  haltAllowlistUserIds?: string[];
  /** Allow any bot sender in the control stream to HALT. */
  haltAllowBotsInControlStream?: boolean;
  /** Explicit CLOSE allowlist (Ian-only by default). */
  closeAllowlistEmails?: string[];
  /** Explicit UNLATCH allowlist (Ian-only by default). */
  unlatchAllowlistEmails?: string[];
  /** Explicit RESUME allowlist (Ian-only by default). */
  resumeAllowlistEmails?: string[];
  /** Explicit KILL allowlist (Ian-only by default). */
  killAllowlistEmails?: string[];
};

export type AgentOrchV1LivenessConfig = {
  heartbeatSeconds?: number;
  emitStillRunning?: boolean;
};

export type AgentOrchV1ControlConfig = {
  /** Control stream name for Zulip control-plane commands. */
  zulipStream?: string;
};

export type AgentOrchV1SubagentsConfig = {
  /** Poll interval for result artifact checks after child run terminal. */
  pollIntervalMs?: number;
  /** Maximum wait before treating missing/invalid result artifact as terminal failure. */
  resultTimeoutMs?: number;
};

export type AgentOrchV1TaxonomyConfig = {
  projectStemRegex?: string;
};

export type AgentOrchV1DedupeConfig = {
  /** Control-command dedupe TTL (seconds). */
  ttlSeconds?: number;
  /** Maximum persisted dedupe entries. */
  maxEntries?: number;
};

export type AgentOrchV1ZulipRoutingConfig = {
  /**
   * Route map for role/instance to Zulip stream.
   * Keys are `role` or `role#<instance>` (for example `engineer` or `engineer#2`).
   */
  roleInstanceMap?: Record<string, string>;
};

export type AgentOrchV1RoutingConfig = {
  /** Zulip adapter routing config. */
  zulip?: AgentOrchV1ZulipRoutingConfig;
};

export type AgentOrchV1TopologyFlatLaneConfig = {
  /** Zulip stream for this lane instance. */
  zulipStream?: string;
};

export type AgentOrchV1TopologyFlatRoleConfig = {
  /** Instance map where keys are numeric strings >= 1. */
  instances?: Record<string, AgentOrchV1TopologyFlatLaneConfig>;
};

export type AgentOrchV1TopologyConfig = {
  kind?: "flat";
  roles?: Record<string, AgentOrchV1TopologyFlatRoleConfig>;
};

export type AgentOrchV1Config = {
  enabled?: boolean;
  stateDir?: string;
  /** Legacy: use control.zulipStream. */
  controlStream?: string;
  control?: AgentOrchV1ControlConfig;
  authority?: AgentOrchV1AuthorityConfig;
  liveness?: AgentOrchV1LivenessConfig;
  subagents?: AgentOrchV1SubagentsConfig;
  taxonomy?: AgentOrchV1TaxonomyConfig;
  dedupe?: AgentOrchV1DedupeConfig;
  routing?: AgentOrchV1RoutingConfig;
  topology?: AgentOrchV1TopologyConfig;
};
