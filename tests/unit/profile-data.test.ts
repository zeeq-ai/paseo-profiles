import { describe, expect, it } from "vitest";
import { ProfileSchema, ProfilesSchema, SetSchema } from "../../shared/set";
import { profile, profileSet } from "../fixtures/profile-sets";

describe("portable profile documents", () => {
  it("preserves optional omissions, nested JSON values, ordering, and unknown profile fields", () => {
    const profiles = [
      profile({
        id: "review",
        name: "Review",
        notes: "First line\nSecond line\n",
        color: "",
        featureValues: {
          disabled: null,
          nested: { entries: ["one", 2, false, null] },
        },
        futureProviderOption: { mode: "strict", stages: [1, 2] },
      }),
      profile({ id: "implement", name: "Implement", model: "example-model" }),
    ];

    expect(ProfilesSchema.parse(profiles)).toEqual(profiles);
    const first = ProfilesSchema.parse(profiles)[0];
    expect(first).toBeDefined();
    expect(Object.hasOwn(first, "model")).toBe(false);
    expect(SetSchema.parse(profileSet({ profiles }))).toEqual(profileSet({ profiles }));
  });

  it("rejects duplicate profile IDs and empty saved sets", () => {
    const duplicateProfiles = [
      profile({ id: "same", name: "First" }),
      profile({ id: "same", name: "Second" }),
    ];

    expect(ProfilesSchema.safeParse(duplicateProfiles).success).toBe(false);
    expect(SetSchema.safeParse(profileSet({ profiles: [] })).success).toBe(false);
  });

  it("rejects non-JSON profile values and non-portable top-level fields", () => {
    const withDate = { ...profile({ id: "review", name: "Review" }), createdAt: new Date(0) };
    const withNonFiniteNumber = {
      ...profile({ id: "review", name: "Review" }),
      featureValues: { threshold: Number.POSITIVE_INFINITY },
    };

    expect(ProfileSchema.safeParse(withDate).success).toBe(false);
    expect(ProfileSchema.safeParse(withNonFiniteNumber).success).toBe(false);
    expect(
      SetSchema.safeParse({ ...profileSet(), privateMachinePath: "/tmp/private" }).success,
    ).toBe(false);
  });
});
