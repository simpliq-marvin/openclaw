import type { ResolvedAgentOrchV1Config } from "./config.js";
import type { AgentOrchIdentity } from "./types.js";

export type AgentOrchPrivilege =
  | "halt"
  | "resume"
  | "unlatch"
  | "close"
  | "kill"
  | "status"
  | "list";

export function isIanIdentity(
  identity: AgentOrchIdentity,
  config: ResolvedAgentOrchV1Config,
): boolean {
  const email = identity.senderEmail?.trim().toLowerCase();
  if (!email) {
    return false;
  }
  return config.authority.ianEmails.has(email);
}

function isAllowlistedEmail(email: string | undefined, allowlist: Set<string>): boolean {
  const normalized = email?.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return allowlist.has(normalized);
}

function isAllowlistedUserId(userId: string | undefined, allowlist: Set<string>): boolean {
  const normalized = userId?.trim();
  if (!normalized) {
    return false;
  }
  return allowlist.has(normalized);
}

export function canExecuteAgentOrchCommand(params: {
  privilege: AgentOrchPrivilege;
  identity: AgentOrchIdentity;
  inControlStream: boolean;
  config: ResolvedAgentOrchV1Config;
}): boolean {
  const { privilege, identity, inControlStream, config } = params;
  if (!inControlStream) {
    return false;
  }
  if (privilege === "status" || privilege === "list") {
    return true;
  }
  if (isIanIdentity(identity, config)) {
    return true;
  }
  if (privilege === "halt") {
    if (isAllowlistedEmail(identity.senderEmail, config.authority.haltAllowlistEmails)) {
      return true;
    }
    if (isAllowlistedUserId(identity.senderUserId, config.authority.haltAllowlistUserIds)) {
      return true;
    }
    return config.authority.haltAllowBotsInControlStream && identity.senderIsBot;
  }
  if (privilege === "close") {
    return isAllowlistedEmail(identity.senderEmail, config.authority.closeAllowlistEmails);
  }
  if (privilege === "unlatch") {
    return isAllowlistedEmail(identity.senderEmail, config.authority.unlatchAllowlistEmails);
  }
  if (privilege === "resume") {
    return isAllowlistedEmail(identity.senderEmail, config.authority.resumeAllowlistEmails);
  }
  if (privilege === "kill") {
    return isAllowlistedEmail(identity.senderEmail, config.authority.killAllowlistEmails);
  }
  return false;
}
