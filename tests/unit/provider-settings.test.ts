import { describe, expect, it } from "vitest";
import { resolveProfileSettings } from "../../server/provider-settings";
import { ProfileSchema } from "../../shared/set";
import { profile } from "../fixtures/profile-sets";

type Catalog = Parameters<typeof resolveProfileSettings>[1];
const catalog: Catalog = [
  { provider: "offline", status: "unavailable", enabled: true },
  {
    provider: "codex",
    status: "ready",
    enabled: true,
    models: [
      { provider: "codex", id: "hidden", label: "Hidden", isSelectable: false },
      { provider: "codex", id: "default", label: "Default", isDefault: true },
      { provider: "codex", id: "local-choice", label: "Local", aliases: ["local-alias"] },
    ],
    modes: [{ id: "local-mode", label: "Local mode" }],
  },
  {
    provider: "other",
    status: "ready",
    enabled: true,
    models: [{ provider: "other", id: "other-default", label: "Other", isDefault: true }],
  },
];

describe("destination provider and model selection", () => {
  it("keeps supported settings and future appearance fields unchanged", () => {
    const source = profile({
      id: "review",
      name: "Review",
      model: "local-alias",
      modeId: "local-mode",
      color: "future-color",
      icon: "future-icon",
      featureValues: { enabled: true },
      futureSetting: { keep: true },
    });
    const resolved = resolveProfileSettings([source], catalog, []);
    expect(resolved.profiles).toEqual([source]);
    expect(resolved.warnings).toEqual([]);
  });

  it("chooses the host's configured provider/model when portable settings are omitted", () => {
    const source = ProfileSchema.parse({ id: "automatic", name: "Automatic" });
    const current = [
      profile({ id: "local", name: "Local", provider: "other", model: "other-default" }),
    ];
    const resolved = resolveProfileSettings([source], catalog, current);
    expect(resolved.profiles[0]).toEqual({ ...source, provider: "other", model: "other-default" });
    expect(resolved.profiles[0]).not.toHaveProperty("color");
    expect(resolved.profiles[0]).not.toHaveProperty("icon");
    expect(source).toEqual({ id: "automatic", name: "Automatic", provider: "" });
  });

  it("uses the local model choice on a missing model and drops incompatible reasoning and mode", () => {
    const source = profile({
      id: "review",
      name: "Review",
      model: "not-installed",
      modeId: "not-supported",
      thinkingOptionId: "old-reasoning",
    });
    const current = [profile({ id: "local", name: "Local", model: "local-choice" })];
    const resolved = resolveProfileSettings([source], catalog, current);
    expect(resolved.profiles[0]).toEqual(
      profile({ id: "review", name: "Review", model: "local-choice" }),
    );
    expect(resolved.warnings.join("\n")).toContain("not-installed");
    expect(source.model).toBe("not-installed");
  });

  it.each([undefined, "retired", "hidden"])("uses a selectable catalog default for %s", (model) => {
    const resolved = resolveProfileSettings(
      [profile({ id: "review", name: "Review", model })],
      catalog,
      [],
    );
    expect(resolved.profiles[0]?.model).toBe("default");
  });

  it("clears provider-specific settings when switching an unavailable provider", () => {
    const source = profile({
      id: "review",
      name: "Review",
      provider: "offline",
      model: "old",
      modeId: "old-mode",
      thinkingOptionId: "high",
      featureValues: { oldFeature: true },
      providerOptions: { oldFlag: true },
      notes: "Keep the assignment",
      icon: "bug",
      color: "red",
    });
    const resolved = resolveProfileSettings([source], catalog, []);
    expect(resolved.profiles[0]).toEqual(
      profile({
        id: "review",
        name: "Review",
        model: "default",
        notes: source.notes,
        icon: "bug",
        color: "red",
      }),
    );
    expect(source).toHaveProperty("providerOptions");
    expect(resolved.warnings.join("\n")).toContain("offline");
  });

  it("preserves explicit settings when the model catalog or all ready providers are unavailable", () => {
    const source = profile({ id: "review", name: "Review", model: "private-model" });
    expect(
      resolveProfileSettings(
        [source],
        [{ provider: "codex", enabled: true, status: "ready" }],
        [],
      ).warnings.join("\n"),
    ).toMatch(/could not be verified/);
    expect(
      resolveProfileSettings([source], [{ provider: "codex", enabled: true, status: "ready" }], [])
        .profiles,
    ).toEqual([source]);
    const resolved = resolveProfileSettings(
      [source],
      catalog.map((entry) => ({ ...entry, enabled: false })),
      [],
    );
    expect(resolved.profiles).toEqual([source]);
    expect(resolved.warnings.join("\n")).toMatch(/no ready provider/);
  });
});
