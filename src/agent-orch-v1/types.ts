export type AgentOrchIdentity = {
  senderEmail?: string;
  senderUserId?: string;
  senderIsBot: boolean;
};

export type AgentOrchInboundContext = {
  channel: string;
  streamName?: string;
  streamId?: string;
  topic?: string;
  messageId?: string;
  identity: AgentOrchIdentity;
};

export type AgentOrchOutboundContext = {
  channel: string;
  streamName?: string;
  streamId?: string;
  topic?: string;
  runId?: string;
  runEpochId?: number;
};

export type AgentOrchParsedProjectTopic = {
  projectStem: string;
  laneRole: string;
  laneInstance: number;
};

export type AgentOrchProjectOrigin = {
  streamName?: string;
  streamId?: string;
  topic: string;
  capturedAt: string;
};

export type AgentOrchProjectLane = {
  streamName?: string;
  streamId?: string;
  topic: string;
  laneRole: string;
  laneInstance: number;
  lastActivityAt: string;
};

export type AgentOrchExternalLatchState = "OPEN" | "CLOSED" | "HALTED";

export type AgentOrchProjectEpoch = {
  kickoffMid: string;
  startedAt: string;
};

export type AgentOrchProjectState = {
  projectStem: string;
  epochId: number;
  epochs: Record<string, AgentOrchProjectEpoch>;
  closedEpoch: number | null;
  halted: boolean;
  origin?: AgentOrchProjectOrigin;
  lanes: Record<string, AgentOrchProjectLane>;
  runFences: Record<string, { epochId: number; fencedAt: string; reason?: string }>;
  updatedAt: string;
};

export type AgentOrchProjectStatePatch = Partial<
  Omit<AgentOrchProjectState, "projectStem" | "lanes" | "runFences" | "epochs"> & {
    lanes: Record<string, AgentOrchProjectLane>;
    epochs: Record<string, AgentOrchProjectEpoch>;
    runFences: Record<string, { epochId: number; fencedAt: string; reason?: string }>;
  }
>;

export type AgentOrchProjectEvent = {
  at: string;
  type: string;
  data?: Record<string, unknown>;
};

export type AgentOrchControlDedupeEntry = {
  mid: string;
  commandKey: string;
  responseText: string;
  processedAt: string;
};

export type AgentOrchRunTerminalStatus = "done" | "failed" | "blocked" | "timeout" | "cancelled";
