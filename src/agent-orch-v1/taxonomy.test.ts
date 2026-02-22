import { describe, expect, it } from "vitest";
import { deriveLaneRoleFromStream, parseProjectTopic } from "./taxonomy.js";

describe("agent-orch-v1 taxonomy", () => {
  it("parses lane topic with role suffix and instance", () => {
    const parsed = parseProjectTopic({
      topic: "project-foo-engineer#2",
      laneRole: "engineer",
      projectStemRegex: /^[a-z0-9-]+$/,
    });
    expect(parsed).toEqual({
      projectStem: "project-foo",
      laneRole: "engineer",
      laneInstance: 2,
    });
  });

  it("defaults lane instance to 1 when suffix is absent", () => {
    const parsed = parseProjectTopic({
      topic: "project-foo",
      laneRole: "strategy",
      projectStemRegex: /^[a-z0-9-]+$/,
    });
    expect(parsed).toEqual({
      projectStem: "project-foo",
      laneRole: "strategy",
      laneInstance: 1,
    });
  });

  it("returns null for invalid project stem", () => {
    const parsed = parseProjectTopic({
      topic: "Project Foo",
      laneRole: "strategy",
      projectStemRegex: /^[a-z0-9-]+$/,
    });
    expect(parsed).toBeNull();
  });

  it("derives lane role from stream names", () => {
    expect(deriveLaneRoleFromStream("Engineer Team")).toBe("engineer-team");
  });
});
