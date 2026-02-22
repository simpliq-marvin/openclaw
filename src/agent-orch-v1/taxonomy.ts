import type { AgentOrchParsedProjectTopic } from "./types.js";

const INSTANCE_SUFFIX_RE = /#([1-9][0-9]*)$/;

function normalizeLaneRole(raw?: string): string {
  return (raw ?? "").trim().toLowerCase();
}

export function deriveLaneRoleFromStream(streamName?: string): string {
  const normalized = normalizeLaneRole(streamName);
  if (!normalized) {
    return "lane";
  }
  return normalized
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/--+/g, "-");
}

export function parseProjectTopic(params: {
  topic?: string;
  laneRole?: string;
  projectStemRegex: RegExp;
}): AgentOrchParsedProjectTopic | null {
  const topicRaw = params.topic?.trim();
  if (!topicRaw) {
    return null;
  }
  let laneInstance = 1;
  let remainder = topicRaw;
  const instanceMatch = remainder.match(INSTANCE_SUFFIX_RE);
  if (instanceMatch?.[1]) {
    laneInstance = Number.parseInt(instanceMatch[1], 10);
    remainder = remainder.slice(0, instanceMatch.index).trim();
  }
  const laneRole = normalizeLaneRole(params.laneRole);
  if (laneRole) {
    const roleSuffix = `-${laneRole}`;
    if (remainder.toLowerCase().endsWith(roleSuffix)) {
      remainder = remainder.slice(0, -roleSuffix.length).trim();
    }
  }
  if (!params.projectStemRegex.test(remainder)) {
    return null;
  }
  return {
    projectStem: remainder,
    laneRole: laneRole || deriveLaneRoleFromStream(undefined),
    laneInstance,
  };
}
