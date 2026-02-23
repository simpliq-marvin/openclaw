export type RouteEnvelope = {
  project: string;
  role: string;
  instance: number;
};

export type RouteEnvelopeParseFailureReason =
  | "invalid-route-shape"
  | "missing-project"
  | "missing-role"
  | "invalid-role"
  | "invalid-instance";

export type RouteEnvelopeParseResult =
  | {
      ok: true;
      envelope: RouteEnvelope;
    }
  | {
      ok: false;
      reason: RouteEnvelopeParseFailureReason;
      project?: string;
      role?: string;
      instance?: number;
    };

export type RouteEnvelopeDiagnostics = {
  project: string;
  role: string;
  instance: string;
};

function asNonEmptyTrimmed(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function parsePositiveInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const int = Math.floor(value);
    return int >= 1 ? int : undefined;
  }
  if (typeof value === "string" && /^[0-9]+$/.test(value.trim())) {
    const int = Number.parseInt(value.trim(), 10);
    return int >= 1 ? int : undefined;
  }
  return undefined;
}

function parseRoleWithSuffix(roleRaw: string): {
  role: string;
  parsedInstance?: number;
  malformedSuffix: boolean;
} {
  const trimmed = roleRaw.trim();
  const hashIndex = trimmed.lastIndexOf("#");
  if (hashIndex === -1) {
    return { role: trimmed, malformedSuffix: false };
  }
  const roleBase = trimmed.slice(0, hashIndex).trim();
  const suffix = trimmed.slice(hashIndex + 1).trim();
  if (!suffix) {
    return { role: roleBase, malformedSuffix: true };
  }
  if (!/^[1-9][0-9]*$/.test(suffix)) {
    return { role: roleBase, malformedSuffix: true };
  }
  const parsedInstance = Number.parseInt(suffix, 10);
  return {
    role: roleBase,
    parsedInstance,
    malformedSuffix: false,
  };
}

export function parseRouteEnvelope(input: unknown): RouteEnvelopeParseResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, reason: "invalid-route-shape" };
  }
  const record = input as Record<string, unknown>;
  const project = asNonEmptyTrimmed(record.project);
  if (!project) {
    return {
      ok: false,
      reason: "missing-project",
      role: asNonEmptyTrimmed(record.role),
      instance: parsePositiveInt(record.instance),
    };
  }

  const roleRaw = asNonEmptyTrimmed(record.role);
  if (!roleRaw) {
    return {
      ok: false,
      reason: "missing-role",
      project,
      instance: parsePositiveInt(record.instance),
    };
  }

  const roleParsed = parseRoleWithSuffix(roleRaw);
  if (roleParsed.malformedSuffix || !roleParsed.role) {
    return {
      ok: false,
      reason: "invalid-role",
      project,
      role: roleRaw,
      instance: parsePositiveInt(record.instance),
    };
  }

  const explicitInstance = parsePositiveInt(record.instance);
  if (record.instance !== undefined && explicitInstance == null) {
    return {
      ok: false,
      reason: "invalid-instance",
      project,
      role: roleParsed.role,
      instance: roleParsed.parsedInstance,
    };
  }

  const instance = explicitInstance ?? roleParsed.parsedInstance ?? 1;
  if (instance < 1 || !Number.isFinite(instance)) {
    return {
      ok: false,
      reason: "invalid-instance",
      project,
      role: roleParsed.role,
    };
  }

  return {
    ok: true,
    envelope: {
      project,
      role: roleParsed.role,
      instance,
    },
  };
}

function sanitizeDiagnosticToken(value: string): string {
  return value.replace(/\s+/g, "-").replaceAll("@", "@\u200b").trim();
}

function resolveDiagnosticToken(value: unknown): string {
  if (typeof value !== "string") {
    return "unknown";
  }
  const trimmed = sanitizeDiagnosticToken(value);
  return trimmed || "unknown";
}

export function buildRouteEnvelopeDiagnostics(params: {
  project?: string;
  role?: string;
  instance?: number;
}): RouteEnvelopeDiagnostics {
  const instance =
    typeof params.instance === "number" && Number.isFinite(params.instance) && params.instance >= 1
      ? String(Math.floor(params.instance))
      : "1";
  return {
    project: resolveDiagnosticToken(params.project),
    role: resolveDiagnosticToken(params.role),
    instance,
  };
}
