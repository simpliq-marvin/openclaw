import type { OpenClawConfig } from "../config/config.js";
import { resolveAgentOrchV1Config } from "./config.js";
import type { RouteEnvelope } from "./route-envelope.js";

export type ZulipRoutingResolveResult =
  | { ok: true; stream: string }
  | { ok: false; reason: "unmapped-role-instance" };

export function resolveZulipRoutingDestination(params: {
  cfg: OpenClawConfig;
  envelope: RouteEnvelope;
}): ZulipRoutingResolveResult {
  const resolved = resolveAgentOrchV1Config(params.cfg);
  const role = params.envelope.role.trim().toLowerCase();
  if (!role) {
    return { ok: false, reason: "unmapped-role-instance" };
  }
  const exactKey = `${role}#${params.envelope.instance}`;
  const map = resolved.routing.zulip.roleInstanceMap;
  const stream = map.get(exactKey) ?? map.get(role);
  if (!stream) {
    return { ok: false, reason: "unmapped-role-instance" };
  }
  return { ok: true, stream };
}
