import { describe, expect, it } from "vitest";
import { parseAgentOrchControlCommand } from "./control-command.js";

describe("agent-orch-v1 control command parser", () => {
  it("parses strict /oc halt with quoted args", () => {
    const parsed = parseAgentOrchControlCommand(
      '/oc halt project=project-foo reason="context spiral risk"',
    );
    expect(parsed.kind).toBe("command");
    if (parsed.kind !== "command") {
      return;
    }
    expect(parsed.name).toBe("halt");
    expect(parsed.project).toBe("project-foo");
    expect(parsed.args.reason).toBe("context spiral risk");
  });

  it("ignores unknown /oc commands", () => {
    const parsed = parseAgentOrchControlCommand("/oc ping project=project-foo");
    expect(parsed).toEqual({ kind: "ignored" });
  });

  it("rejects missing project argument", () => {
    const parsed = parseAgentOrchControlCommand("/oc halt reason=test");
    expect(parsed.kind).toBe("invalid");
  });
});
