import { describe, expect, it } from "vitest";
import { parseSet, serializeSet } from "../../server/yaml";
import { profile, profileSet } from "../fixtures/profile-sets";

const minimalSet = `format: paseo-profile-set
version: 1
id: jamie-engineering
name: Jamie Engineering
profiles:
  - id: review
    name: Review
    provider: codex
`;

describe("portable YAML boundary", () => {
  it("round-trips optional omissions, nested JSON values, and unknown profile fields", () => {
    const set = profileSet({
      appendSystemPrompt: "Shared instructions\nPreserve this line.\n",
      profiles: [
        profile({
          id: "review",
          name: "Review",
          notes: "First line\nSecond line\n",
          color: "",
          icon: "future-icon",
          featureValues: { disabled: null, nested: { values: ["one", 2, false, null] } },
          futureProviderField: { source: "new SDK", levels: [1, 3] },
        }),
        profile({ id: "implement", name: "Implement", model: "example-model" }),
      ],
    });

    const encoded = serializeSet(set);
    const decoded = parseSet(encoded);

    expect(decoded).toEqual({ set, hasIdentity: true });
    expect(encoded).toContain("First line");
    expect(encoded).toContain("Second line");
  });

  it("projects only profiles and the shared prompt from persisted or SDK-shaped config", () => {
    const selected = [profile({ id: "keep", name: "Keep" })];
    const text = JSON.stringify({
      daemon: { agentProfiles: selected, appendSystemPrompt: "Shared daemon prompt" },
      agentProfiles: [profile({ id: "wrong", name: "Wrong" })],
      providers: { openai: { apiKey: "must-not-export" } },
    });

    const decoded = parseSet(text, "Current agent profiles");

    expect(decoded.hasIdentity).toBe(false);
    expect(decoded.set.profiles).toEqual(selected);
    expect(decoded.set.name).toBe("Current agent profiles");
    expect(decoded.set.appendSystemPrompt).toBe("Shared daemon prompt");
    expect(JSON.stringify(decoded)).not.toContain("must-not-export");
    expect(JSON.stringify(decoded)).not.toContain("wrong");
  });

  it("accepts omitted provider, model, color, and icon, and distinguishes absent from empty prompts", () => {
    const decoded = parseSet(minimalSet.replace("    provider: codex\n", ""));
    expect(decoded.set.profiles[0]).toEqual({ id: "review", name: "Review", provider: "" });
    expect(decoded.set).not.toHaveProperty("appendSystemPrompt");
    const empty = parseSet(`${minimalSet}appendSystemPrompt: ''\n`).set;
    expect(empty.appendSystemPrompt).toBe("");
    expect(parseSet(serializeSet(empty)).set).toEqual(empty);
    expect(
      parseSet(
        JSON.stringify({
          agentProfiles: decoded.set.profiles,
          appendSystemPrompt: "Raw SDK prompt",
        }),
      ).set.appendSystemPrompt,
    ).toBe("Raw SDK prompt");
  });

  it.each([
    [
      "duplicate mapping keys",
      minimalSet.replace("name: Jamie Engineering", "name: first\nname: second"),
    ],
    [
      "YAML aliases",
      minimalSet.replace("name: Review", "name: &profileName Review\n    notes: *profileName"),
    ],
    ["custom tags", minimalSet.replace("name: Review", "name: !!str Review")],
    [
      "duplicate profile IDs",
      minimalSet.replace(
        "    provider: codex",
        "    provider: codex\n  - id: review\n    name: Second\n    provider: codex",
      ),
    ],
    [
      "nonfinite numbers",
      minimalSet.replace(
        "    provider: codex",
        "    provider: codex\n    featureValues:\n      threshold: .inf",
      ),
    ],
  ])("rejects %s before treating input as a profile set", (_case, text) => {
    expect(() => parseSet(text)).toThrow();
  });
});
