import { describe, expect, it } from "vitest";
import { canonicalJson, profilesDiff } from "../../shared/canonical";
import { describeImport } from "../../shared/import-plan";
import { profile, profileSet } from "../fixtures/profile-sets";

describe("profile comparisons used in review", () => {
  it("treats object-key order as equal but keeps array order significant", () => {
    expect(canonicalJson({ featureValues: { b: 2, a: 1 } })).toBe(
      canonicalJson({ featureValues: { a: 1, b: 2 } }),
    );
    expect(canonicalJson(["review", "implement"])).not.toBe(canonicalJson(["implement", "review"]));
  });

  it("reports added, changed, removed, and reordered profiles for the complete list", () => {
    const before = [
      profile({ id: "review", name: "Review", notes: "old" }),
      profile({ id: "remove-me", name: "Remove me" }),
      profile({ id: "keep", name: "Keep" }),
    ];
    const after = [
      profile({ id: "keep", name: "Keep" }),
      profile({ id: "review", name: "Review", notes: "new" }),
      profile({ id: "added", name: "Added" }),
    ];

    expect(profilesDiff(before, after)).toEqual({
      added: ["added"],
      changed: ["review"],
      removed: ["remove-me"],
      reordered: true,
    });
  });

  it("retains local edits when the source is unchanged from the imported baseline", () => {
    const baseline = profileSet({
      profiles: [profile({ id: "review", name: "Review", notes: "Jamie" })],
    });
    const current = profileSet({
      profiles: [profile({ id: "review", name: "Review", notes: "local edit" })],
    });
    const result = describeImport(current, baseline, baseline);

    expect(result).toMatchObject({
      sourceUnchanged: true,
      localChanges: true,
      message: "Source unchanged; local changes retained",
      locallyEdited: { changed: ["review"] },
    });
  });

  it("recognizes a local head already matching the new source while the baseline advances", () => {
    const oldBaseline = profileSet({
      profiles: [profile({ id: "review", name: "Review", notes: "old" })],
    });
    const nextSource = profileSet({
      profiles: [profile({ id: "review", name: "Review", notes: "new" })],
    });
    const result = describeImport(nextSource, nextSource, oldBaseline);

    expect(result).toMatchObject({
      sourceUnchanged: false,
      localChanges: true,
      diff: { changed: [] },
      locallyEdited: { changed: ["review"] },
    });
  });
});
