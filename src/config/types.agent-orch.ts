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

export type AgentOrchV1Config = {
  enabled?: boolean;
  stateDir?: string;
  controlStream?: string;
  authority?: AgentOrchV1AuthorityConfig;
  liveness?: AgentOrchV1LivenessConfig;
  taxonomy?: AgentOrchV1TaxonomyConfig;
  dedupe?: AgentOrchV1DedupeConfig;
  routing?: AgentOrchV1RoutingConfig;
};
