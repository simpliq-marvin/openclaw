import type { OpenClawConfig } from "../config/config.js";
import type { RouteEnvelope } from "./route-envelope.js";
import { resolveAgentOrchLaneByRoleInstance } from "./topology.js";

export type ZulipRoutingResolveResult =
  | { ok: true; stream: string }
  | { ok: false; reason: "unmapped-role-instance" };

export function resolveZulipRoutingDestination(params: {
  cfg: OpenClawConfig;
  envelope: RouteEnvelope;
}): ZulipRoutingResolveResult {
  const lane = resolveAgentOrchLaneByRoleInstance({
    cfg: params.cfg,
    role: params.envelope.role,
    instance: params.envelope.instance,
  });
  if (!lane?.zulipStream) {
    return { ok: false, reason: "unmapped-role-instance" };
  }
  return { ok: true, stream: lane.zulipStream };
}
