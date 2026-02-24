import fs from "node:fs/promises";
import path from "node:path";

export type SubagentResultStatus = "done" | "blocked" | "failed";

export type SubagentResultPayload = {
  status: SubagentResultStatus;
  finishedAt: string;
  summary: string[];
  outputs: string[];
  project: string;
  epochId: number;
  runId: string;
  parentRunId: string;
  blocker?: string | Record<string, unknown>;
  error?: Record<string, unknown>;
};

type ResultValidationExpected = {
  projectStem?: string;
  epochId?: number;
  runId: string;
  parentRunId?: string | null;
};

type ResultValidation =
  | {
      ok: true;
      result: SubagentResultPayload;
    }
  | {
      ok: false;
      reason: string;
    };

export type WaitForSubagentResultArtifactResult =
  | {
      ok: true;
      result: SubagentResultPayload;
    }
  | {
      ok: false;
      reason: string;
    };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function toNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function isIsoTimestamp(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeSummary(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const out = value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
  if (out.length < 1 || out.length > 6) {
    return null;
  }
  return out;
}

function normalizeOutputs(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      return null;
    }
    const trimmed = entry.trim();
    if (!trimmed || !path.isAbsolute(trimmed)) {
      return null;
    }
    out.push(trimmed);
  }
  return out;
}

function validateResultPayload(params: {
  raw: unknown;
  expected: ResultValidationExpected;
}): ResultValidation {
  if (!isPlainObject(params.raw)) {
    return { ok: false, reason: "result-json-not-object" };
  }
  const status = toNonEmptyString(params.raw.status);
  if (status !== "done" && status !== "blocked" && status !== "failed") {
    return { ok: false, reason: "invalid-status" };
  }
  const finishedAt = toNonEmptyString(params.raw.finishedAt);
  if (!finishedAt || !isIsoTimestamp(finishedAt)) {
    return { ok: false, reason: "invalid-finishedAt" };
  }
  const summary = normalizeSummary(params.raw.summary);
  if (!summary) {
    return { ok: false, reason: "invalid-summary" };
  }
  const outputs = normalizeOutputs(params.raw.outputs);
  if (!outputs) {
    return { ok: false, reason: "invalid-outputs" };
  }
  const project = toNonEmptyString(params.raw.project);
  if (!project) {
    return { ok: false, reason: "invalid-project" };
  }
  if (params.expected.projectStem && project !== params.expected.projectStem) {
    return { ok: false, reason: "project-mismatch" };
  }

  const epochIdRaw = params.raw.epochId;
  if (typeof epochIdRaw !== "number" || !Number.isFinite(epochIdRaw)) {
    return { ok: false, reason: "invalid-epochId" };
  }
  const epochId = Math.floor(epochIdRaw);
  if (epochId < 0) {
    return { ok: false, reason: "invalid-epochId" };
  }
  if (
    typeof params.expected.epochId === "number" &&
    Number.isFinite(params.expected.epochId) &&
    epochId !== Math.floor(params.expected.epochId)
  ) {
    return { ok: false, reason: "epochId-mismatch" };
  }

  const runId = toNonEmptyString(params.raw.runId);
  if (!runId || runId !== params.expected.runId) {
    return { ok: false, reason: "runId-mismatch" };
  }
  const parentRunId = toNonEmptyString(params.raw.parentRunId);
  if (!parentRunId) {
    return { ok: false, reason: "invalid-parentRunId" };
  }
  const expectedParentRunId = params.expected.parentRunId?.trim();
  if (expectedParentRunId && parentRunId !== expectedParentRunId) {
    return { ok: false, reason: "parentRunId-mismatch" };
  }

  if (status === "blocked") {
    const blocker = params.raw.blocker;
    if (typeof blocker !== "string" && !isPlainObject(blocker)) {
      return { ok: false, reason: "missing-blocker" };
    }
  }

  if (status === "failed" && params.raw.error != null && !isPlainObject(params.raw.error)) {
    return { ok: false, reason: "invalid-error" };
  }

  return {
    ok: true,
    result: {
      status,
      finishedAt,
      summary,
      outputs,
      project,
      epochId,
      runId,
      parentRunId,
      blocker:
        typeof params.raw.blocker === "string" || isPlainObject(params.raw.blocker)
          ? params.raw.blocker
          : undefined,
      error: isPlainObject(params.raw.error) ? params.raw.error : undefined,
    },
  };
}

async function readAndValidateResultArtifact(params: {
  resultPath: string;
  expected: ResultValidationExpected;
}): Promise<ResultValidation> {
  let raw: string;
  try {
    raw = await fs.readFile(params.resultPath, "utf8");
  } catch (error) {
    const codeValue =
      error && typeof error === "object" && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
    const code =
      typeof codeValue === "string"
        ? codeValue
        : typeof codeValue === "number"
          ? `${codeValue}`
          : "";
    if (code === "ENOENT") {
      return { ok: false, reason: "missing-result-json" };
    }
    return { ok: false, reason: `read-error:${code || "unknown"}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "invalid-json" };
  }
  return validateResultPayload({
    raw: parsed,
    expected: params.expected,
  });
}

export async function waitForSubagentResultArtifact(params: {
  resultPath: string;
  expected: ResultValidationExpected;
  timeoutMs: number;
  pollIntervalMs: number;
}): Promise<WaitForSubagentResultArtifactResult> {
  const timeoutMs = Math.max(1, Math.floor(params.timeoutMs));
  const pollIntervalMs = Math.max(1, Math.floor(params.pollIntervalMs));
  const deadline = Date.now() + timeoutMs;
  let lastReason = "missing-result-json";

  while (true) {
    const validated = await readAndValidateResultArtifact({
      resultPath: params.resultPath,
      expected: params.expected,
    });
    if (validated.ok) {
      return validated;
    }
    lastReason = validated.reason;
    if (Date.now() >= deadline) {
      return {
        ok: false,
        reason: lastReason,
      };
    }
    await sleep(pollIntervalMs);
  }
}
