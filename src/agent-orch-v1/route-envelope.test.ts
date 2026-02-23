import { describe, expect, it } from "vitest";
import { buildRouteEnvelopeDiagnostics, parseRouteEnvelope } from "./route-envelope.js";

describe("agent-orch-v1 route envelope parser", () => {
  it("parses role#instance shorthand", () => {
    const parsed = parseRouteEnvelope({
      project: "project-foo",
      role: "engineer#2",
    });
    expect(parsed).toEqual({
      ok: true,
      envelope: {
        project: "project-foo",
        role: "engineer",
        instance: 2,
      },
    });
  });

  it("uses explicit instance over role shorthand", () => {
    const parsed = parseRouteEnvelope({
      project: "project-foo",
      role: "engineer#2",
      instance: 3,
    });
    expect(parsed).toEqual({
      ok: true,
      envelope: {
        project: "project-foo",
        role: "engineer",
        instance: 3,
      },
    });
  });

  it("rejects missing role", () => {
    const parsed = parseRouteEnvelope({
      project: "project-foo",
    });
    expect(parsed).toMatchObject({
      ok: false,
      reason: "missing-role",
    });
  });

  it("rejects invalid instance", () => {
    const parsed = parseRouteEnvelope({
      project: "project-foo",
      role: "engineer",
      instance: 0,
    });
    expect(parsed).toMatchObject({
      ok: false,
      reason: "invalid-instance",
    });
  });

  it("builds unknown diagnostics when values are missing", () => {
    expect(buildRouteEnvelopeDiagnostics({})).toEqual({
      project: "unknown",
      role: "unknown",
      instance: "1",
    });
  });
});
