import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseSet, serializeSet } from "../../server/yaml";
import { SetSchema } from "../../shared/set";
import { profile, profileSet } from "../fixtures/profile-sets";

// The v1 reader exactly as shipped before Gist links existed. Compatibility with it is the whole
// reason a portable pointer needs version 2, so it is pinned here as an independent fixture.
const ShippedV1Schema = z
  .object({
    format: z.literal("paseo-profile-set"),
    version: z.literal(1),
    id: z.string().min(1),
    name: z.string().trim().min(1),
    origin: z.object({ fingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/) }).optional(),
    copiedFrom: z.string().optional(),
    appendSystemPrompt: z.string().optional(),
    profiles: z.array(z.object({ id: z.string() }).passthrough()).min(1),
  })
  .strict();

const V1_TEXT = `format: paseo-profile-set
version: 1
id: jamie-engineering-set
name: Jamie Engineering
origin:
  fingerprint: sha256:${"a".repeat(64)}
appendSystemPrompt: |
  Shared
  prompt
profiles:
  - id: a
    name: A
    provider: codex
    model: m
`;

const V2_TEXT = `format: paseo-profile-set
version: 2
id: 2dbfbd3d-81eb-4ab2-90a4-45dd2ef67e2b
name: Fast review
gist:
  id: 3f9ac21e
  file: fast-review.yaml
profiles:
  - id: reviewer
    name: Reviewer
    provider: codex
`;

const withGist = (overrides: string) =>
  V2_TEXT.replace(/gist:\n {2}id: .*\n {2}file: .*\n/, overrides);

describe("profile-pack format versions", () => {
  it("keeps version 1 output byte-for-byte stable when no portable link is present", () => {
    const set = profileSet({
      appendSystemPrompt: "Shared\nprompt\n",
      profiles: [profile({ id: "a", name: "A", model: "m" })],
    });

    expect(serializeSet(set)).toBe(V1_TEXT);
    expect(ShippedV1Schema.safeParse(parseSet(V1_TEXT).set).success).toBe(true);
  });

  it("reads a v2 pack with a pointer and round-trips it without loss", () => {
    const { set, hasIdentity } = parseSet(V2_TEXT);

    expect(hasIdentity).toBe(true);
    expect(set.version).toBe(2);
    expect(set.gist).toEqual({ id: "3f9ac21e", file: "fast-review.yaml" });
    expect(serializeSet(set)).toBe(V2_TEXT);
  });

  it("reads v2 and v1 packs that carry no pointer", () => {
    expect(
      parseSet(V2_TEXT.replace(/gist:\n {2}id: .*\n {2}file: .*\n/, "")).set.gist,
    ).toBeUndefined();
    expect(parseSet(V1_TEXT).set.gist).toBeUndefined();
  });

  it("makes a pack with a pointer unreadable to a shipped v1 reader instead of dropping the link", () => {
    const parsed = parseSet(V2_TEXT);
    const asObject = JSON.parse(JSON.stringify(parsed.set));

    expect(ShippedV1Schema.safeParse(asObject).success).toBe(false);
    // And the serialized text, not just the in-memory object, declares the incompatible version.
    expect(serializeSet(parsed.set)).toMatch(/^version: 2$/m);
  });

  it("never writes a pointer into a version 1 document", () => {
    const set = profileSet();
    const upgraded = { ...set, version: 2 as const, gist: { id: "abcde", file: "a.yaml" } };
    expect(serializeSet(upgraded)).toMatch(/^version: 2$/m);
    expect(serializeSet(upgraded)).toMatch(/^gist:/m);
    expect(() => SetSchema.parse({ ...upgraded, version: 1 })).toThrow(/version 2/);
    expect(() => parseSet(V2_TEXT.replace("version: 2", "version: 1"))).toThrow();
  });

  it.each([
    ["an unknown version", V2_TEXT.replace("version: 2", "version: 3")],
    [
      "an unknown pointer key",
      withGist("gist:\n  id: 3f9ac21e\n  file: a.yaml\n  revision: abc\n"),
    ],
    ["a pointer without a file", withGist("gist:\n  id: 3f9ac21e\n")],
    ["a pointer without an ID", withGist("gist:\n  file: a.yaml\n")],
    ["a non-hex Gist ID", withGist("gist:\n  id: not-a-gist\n  file: a.yaml\n")],
    ["a path in the file name", withGist("gist:\n  id: 3f9ac21e\n  file: ../a.yaml\n")],
    ["a backslash in the file name", withGist("gist:\n  id: 3f9ac21e\n  file: 'a\\b.yaml'\n")],
    ["an empty file name", withGist("gist:\n  id: 3f9ac21e\n  file: ''\n")],
    ["a scalar pointer", withGist("gist: 3f9ac21e\n")],
    [
      "a URL instead of an ID",
      withGist("gist:\n  id: https://gist.github.com/x/3f9ac21e\n  file: a.yaml\n"),
    ],
    ["a duplicated pointer key", `${V2_TEXT}gist:\n  id: abcde\n  file: b.yaml\n`],
    [
      "an unknown top-level key",
      V2_TEXT.replace("name: Fast review", "name: Fast review\ngistUrl: x"),
    ],
  ])("rejects %s", (_label, text) => {
    expect(() => parseSet(text)).toThrow();
  });

  it("does not let a pointer smuggle a revision or hash into the file it describes", () => {
    for (const key of [
      "revision",
      "version",
      "hash",
      "sha",
      "contentHash",
      "lastConfirmedRevision",
    ]) {
      expect(() =>
        parseSet(withGist(`gist:\n  id: 3f9ac21e\n  file: a.yaml\n  ${key}: abc\n`)),
      ).toThrow();
    }
  });
});
