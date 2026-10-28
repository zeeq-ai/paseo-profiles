import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { hash } from "../../server/files";
import { serializeSet } from "../../server/yaml";
import type { ProfileSet } from "../../shared/set";
import { semanticSet } from "../../shared/set";
import { profile, profileSet } from "../fixtures/profile-sets";
import { createPublicationFixture, type PublicationFixture } from "../support/publication";

const fixtures: PublicationFixture[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()));
});
async function setup(options: Parameters<typeof createPublicationFixture>[0] = {}) {
  const fixture = await createPublicationFixture(options);
  fixtures.push(fixture);
  return fixture;
}

const FILE = "fast-review.yaml";
const pack = (overrides: Partial<ProfileSet> = {}) =>
  profileSet({
    id: "pack-a",
    name: "Fast review",
    profiles: [profile({ id: "reviewer", name: "Reviewer", model: "m1" })],
    ...overrides,
  });
const sha = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;

/** What a successful earlier publish would have recorded for this pack and text. */
const baselineOf = (set: ProfileSet, text: string) => ({
  fileHash: sha(text),
  contentHash: hash(semanticSet(set)),
  recordedAt: "2026-10-28T12:00:00.000Z",
  source: "published" as const,
});

/** A saved pack linked to a Gist on this host and confirmed here, as after a past publish. */
async function linked(
  f: PublicationFixture,
  options: { owner?: { id: number; login: string }; extraFiles?: Record<string, string> } = {},
) {
  const entry = await f.save(pack());
  const text = serializeSet(entry.set);
  const gist = await f.gh.seed({
    owner: options.owner,
    files: { [FILE]: text, ...options.extraFiles },
  });
  await f.writeHostRecord({
    localId: entry.localId,
    packId: entry.set.id,
    pointer: { gistId: gist.id, fileName: FILE },
    trusted: { gistId: gist.id, fileName: FILE, confirmedAt: "2026-10-28T12:00:00.000Z" },
    baseline: baselineOf(entry.set, text),
  });
  return { entry, text, gist };
}
const check = async (f: PublicationFixture, localId: string) =>
  (await f.service.status({ libraryRoot: "", localIds: [localId], check: true })).statuses[0];

describe("gist.inspect", () => {
  it("shows owner, visibility, every file, and suggests the one file with this pack's ID", async () => {
    const f = await setup();
    const entry = await f.save(pack());
    const gist = await f.gh.seed({
      public: true,
      files: {
        "mine.yaml": serializeSet(entry.set),
        "other.yaml": serializeSet(pack({ id: "pack-b", name: "Other" })),
        "broken.yaml": "profiles: [unterminated",
        "data.json": "{}",
        "README.md": "hello\n",
      },
    });
    await f.gh.clearRequests();

    const result = await f.service.inspect({
      libraryRoot: "",
      gistId: gist.id,
      localId: entry.localId,
    });

    expect(result.account).toEqual({ id: 1001, login: "charles" });
    expect(result.ownership).toBe("owner");
    expect(result.gist).toMatchObject({ id: gist.id, public: true, owner: { login: "charles" } });
    expect(result.suggestedFile).toBe("mine.yaml");
    const byName = Object.fromEntries(result.files.map((file) => [file.name, file]));
    expect(byName["mine.yaml"]).toMatchObject({
      kind: "yaml",
      matchesPack: true,
      linkable: true,
      packId: "pack-a",
    });
    expect(byName["other.yaml"]).toMatchObject({ matchesPack: false, linkable: false });
    expect(byName["broken.yaml"]?.parseError).toBeTruthy();
    expect(byName["broken.yaml"]?.linkable).toBe(false);
    expect(byName["data.json"]?.kind).toBe("json");
    expect(byName["README.md"]).toMatchObject({ kind: "other", linkable: false });
    expect(await f.gh.writes()).toEqual([]);
  });

  it("never picks between two files carrying the same pack ID", async () => {
    const f = await setup();
    const entry = await f.save(pack());
    const text = serializeSet(entry.set);
    const gist = await f.gh.seed({ files: { "a.yaml": text, "b.yaml": text } });

    const result = await f.service.inspect({
      libraryRoot: "",
      gistId: gist.id,
      localId: entry.localId,
    });

    expect(result.suggestedFile).toBeUndefined();
    expect(result.files.filter((file) => file.linkable)).toHaveLength(2);
  });

  it("reports a foreign Gist as read-only for this account and uses the effective identity", async () => {
    const f = await setup({ user: { id: 1001, login: "charles" } });
    await f.gh.mutate((state) => {
      state.tokens.work = { id: 3003, login: "work-bot" };
    });
    const entry = await f.save(pack());
    const gist = await f.gh.seed({
      owner: { id: 3003, login: "work-bot" },
      files: { [FILE]: serializeSet(entry.set) },
    });

    const asCharles = await f.service.inspect({ libraryRoot: "", gistId: gist.id });
    expect(asCharles.ownership).toBe("not-owner");
    expect(asCharles.account.login).toBe("charles");

    process.env.GH_TOKEN = "work";
    try {
      const asBot = await f.service.inspect({ libraryRoot: "", gistId: gist.id });
      expect(asBot.ownership).toBe("owner");
      expect(asBot.account.login).toBe("work-bot");
    } finally {
      process.env.GH_TOKEN = "";
    }
  });

  it("accepts a full Gist URL and rejects other hosts", async () => {
    const f = await setup();
    const gist = await f.gh.seed({ files: { [FILE]: serializeSet(pack()) } });

    expect(
      (
        await f.service.inspect({
          libraryRoot: "",
          url: `https://gist.github.com/charles/${gist.id}`,
        })
      ).gist.id,
    ).toBe(gist.id);
    await expect(
      f.service.inspect({ libraryRoot: "", url: `https://evil.example.com/charles/${gist.id}` }),
    ).rejects.toThrow();
  });
});

describe("gist.status classification", () => {
  it("an unlinked pack is unlinked and a list never contacts GitHub", async () => {
    const f = await setup();
    const a = await f.save(pack());
    await f.save(pack({ id: "pack-b", name: "B" }));
    const { text } = await linked(f);
    expect(text).toBeTruthy();
    await f.gh.clearRequests();

    const { statuses } = await f.service.status({ libraryRoot: "", check: false });

    expect(statuses).toHaveLength(3);
    expect(statuses.find((s) => s.localId === a.localId)?.state).toBeDefined();
    expect(statuses.every((s) => s.checked === false)).toBe(true);
    expect(await f.gh.requests()).toEqual([]);
    expect(statuses.filter((s) => s.state === "unlinked")).toHaveLength(2);
  });

  it("a linked pack identical to its Gist is up to date, even after an unrelated file changes", async () => {
    const f = await setup();
    const { entry, gist } = await linked(f, { extraFiles: { "notes.md": "v1\n" } });
    expect((await check(f, entry.localId))?.state).toBe("up-to-date");

    await f.gh.edit(gist.id, "notes.md", "completely different\n");
    await f.gh.edit(gist.id, "another.txt", "new file\n");

    const status = await check(f, entry.localId);
    expect(status?.state).toBe("up-to-date");
    expect(status?.remote?.otherFileCount).toBe(2);
    expect(status?.checked).toBe(true);
    expect(await f.gh.writes()).toEqual([]);
  });

  it("a local edit alone is Unpublished changes, known without any network call", async () => {
    const f = await setup();
    const { entry } = await linked(f);
    const edited = await f.save(
      { ...entry.set, name: "Fast review v2" },
      entry.localId,
      entry.revision,
    );
    await f.gh.clearRequests();

    const cached = (
      await f.service.status({ libraryRoot: "", localIds: [edited.localId], check: false })
    ).statuses[0];
    expect(cached?.state).toBe("unpublished-changes");
    expect(cached?.localChanged).toBe(true);
    expect(await f.gh.requests()).toEqual([]);
    expect((await check(f, edited.localId))?.state).toBe("unpublished-changes");
  });

  it("a remote edit alone is Remote changed; both sides edited is Both changed", async () => {
    const f = await setup();
    const { entry, gist } = await linked(f);
    const remote = serializeSet(
      pack({ profiles: [profile({ id: "reviewer", name: "Reviewer", model: "remote-model" })] }),
    );
    await f.gh.edit(gist.id, FILE, remote);

    expect((await check(f, entry.localId))?.state).toBe("remote-changed");

    await f.save({ ...entry.set, name: "Local rename" }, entry.localId, entry.revision);
    expect((await check(f, entry.localId))?.state).toBe("both-changed");
  });

  it("identical content with a stale recorded baseline refreshes without a remote write", async () => {
    const f = await setup();
    const { entry, gist, text } = await linked(f);
    await f.writeHostRecord({
      localId: entry.localId,
      packId: entry.set.id,
      pointer: { gistId: gist.id, fileName: FILE },
      trusted: { gistId: gist.id, fileName: FILE, confirmedAt: "2026-10-28T12:00:00.000Z" },
      baseline: { ...baselineOf(entry.set, text), fileHash: sha("an older published file\n") },
    });

    const status = await check(f, entry.localId);

    expect(status?.state).toBe("baseline-refresh");
    expect(await f.gh.writes()).toEqual([]);
  });

  it("a pointer never confirmed on this host needs confirmation even when the Gist matches", async () => {
    const f = await setup();
    const entry = await f.save(pack());
    const gist = await f.gh.seed({ files: { [FILE]: serializeSet(entry.set) } });
    await f.writeHostRecord({
      localId: entry.localId,
      packId: entry.set.id,
      pointer: { gistId: gist.id, fileName: FILE },
      baseline: baselineOf(entry.set, serializeSet(entry.set)),
    });

    const cached = (
      await f.service.status({ libraryRoot: "", localIds: [entry.localId], check: false })
    ).statuses[0];
    const checked = await check(f, entry.localId);

    expect(cached?.state).toBe("needs-confirmation");
    expect(checked?.state).toBe("needs-confirmation");
    expect(checked?.confirmed).toBe(false);
  });

  it("a copied portable pointer is untrusted until this host confirms it", async () => {
    const f = await setup();
    const gist = await f.gh.seed({ files: { [FILE]: "placeholder: 1\n" } });
    const entry = await f.save({ ...pack(), version: 2, gist: { id: gist.id, file: FILE } });

    const status = (
      await f.service.status({ libraryRoot: "", localIds: [entry.localId], check: false })
    ).statuses[0];

    expect(status?.pointer).toEqual({ gistId: gist.id, fileName: FILE });
    expect(status?.state).toBe("needs-confirmation");
    expect(status?.confirmed).toBe(false);
  });

  it("different pointers in two locations are a conflict that exposes no active target", async () => {
    const f = await setup();
    const entry = await f.save({ ...pack(), version: 2, gist: { id: "aaaaa", file: FILE } });
    await f.writeHostRecord({
      localId: entry.localId,
      packId: entry.set.id,
      pointer: { gistId: "bbbbb", fileName: FILE },
    });

    const status = (
      await f.service.status({ libraryRoot: "", localIds: [entry.localId], check: false })
    ).statuses[0];

    expect(status?.state).toBe("link-conflict");
    expect(status?.pointer).toBeUndefined();
    expect(status?.locations.map((l) => l.location).sort()).toEqual(["host", "portable"]);
    expect(status?.blockers.map((b) => b.code)).toContain("link-conflict");
    // A conflict is never resolved by asking GitHub or by preferring one location.
    expect((await check(f, entry.localId))?.state).toBe("link-conflict");
    expect(await f.gh.requests()).toEqual([]);
  });

  it("the same pointer in two locations is not a conflict", async () => {
    const f = await setup();
    const gist = await f.gh.seed({ files: { [FILE]: "x: 1\n" } });
    const entry = await f.save({ ...pack(), version: 2, gist: { id: gist.id, file: FILE } });
    await f.writeHostRecord({
      localId: entry.localId,
      packId: entry.set.id,
      pointer: { gistId: gist.id.toUpperCase(), fileName: FILE },
    });

    const status = (
      await f.service.status({ libraryRoot: "", localIds: [entry.localId], check: false })
    ).statuses[0];

    expect(status?.state).not.toBe("link-conflict");
    expect(status?.locations).toHaveLength(2);
  });

  it("ignores a host record that belongs to another pack instead of trusting its pointer", async () => {
    const f = await setup();
    const entry = await f.save(pack());
    const gist = await f.gh.seed({ files: { [FILE]: serializeSet(entry.set) } });
    await f.writeHostRecord({
      localId: entry.localId,
      packId: "some-other-pack",
      pointer: { gistId: gist.id, fileName: FILE },
      trusted: { gistId: gist.id, fileName: FILE, confirmedAt: "2026-10-28T12:00:00.000Z" },
    });

    const status = (
      await f.service.status({ libraryRoot: "", localIds: [entry.localId], check: false })
    ).statuses[0];

    expect(status?.state).toBe("unlinked");
    expect(status?.pointer).toBeUndefined();
  });

  it("blocks, rather than recreating, an established file that has disappeared", async () => {
    const f = await setup();
    const { entry, gist } = await linked(f, { extraFiles: { "notes.md": "n\n" } });
    await f.gh.edit(gist.id, FILE, null);

    const status = await check(f, entry.localId);

    expect(status?.state).toBe("blocked");
    expect(status?.blockers.map((b) => b.code)).toContain("file-missing");
    expect(await f.gh.writes()).toEqual([]);
  });

  it("blocks a bound file that now holds a different pack, and a JSON file", async () => {
    const f = await setup();
    const { entry, gist } = await linked(f);
    await f.gh.edit(
      gist.id,
      FILE,
      serializeSet(pack({ id: "someone-elses-pack", name: "Theirs" })),
    );
    const mismatch = await check(f, entry.localId);
    expect(mismatch?.state).toBe("blocked");
    expect(mismatch?.blockers.map((b) => b.code)).toContain("pack-id-mismatch");

    const json = await linked(f);
    await f.writeHostRecord({
      localId: json.entry.localId,
      packId: json.entry.set.id,
      pointer: { gistId: json.gist.id, fileName: "pack.json" },
      trusted: {
        gistId: json.gist.id,
        fileName: "pack.json",
        confirmedAt: "2026-10-28T12:00:00.000Z",
      },
    });
    await f.gh.edit(json.gist.id, "pack.json", "{}");
    const jsonStatus = await check(f, json.entry.localId);
    expect(jsonStatus?.state).toBe("blocked");
    expect(jsonStatus?.blockers.map((b) => b.code)).toContain("json-file");
  });

  it("shows a Gist owned by someone else as not-owner with both identities, and never writes", async () => {
    const f = await setup();
    const { entry } = await linked(f, { owner: { id: 2002, login: "jamie" } });

    const status = await check(f, entry.localId);

    expect(status?.ownership).toBe("not-owner");
    expect(status?.account?.login).toBe("charles");
    expect(status?.remote?.owner.login).toBe("jamie");
    expect(status?.blockers.map((b) => b.code)).toContain("not-owner");
    expect(await f.gh.writes()).toEqual([]);
  });

  it("reports a logged-out host as Check GitHub account, not as a pack problem", async () => {
    const f = await setup();
    const { entry } = await linked(f);
    await f.gh.mutate((state) => {
      state.loggedOut = true;
    });

    const status = await check(f, entry.localId);

    expect(status?.state).toBe("check-github-account");
    expect(status?.checkError?.kind).toBe("auth");
  });

  it("surfaces a deleted Gist and an oversized response as check errors, never as up to date", async () => {
    const f = await setup();
    const { entry, gist } = await linked(f);
    await f.gh.mutate((state) => {
      const target = state.gists[gist.id];
      if (target) target.responseTruncated = true;
    });
    const truncated = await check(f, entry.localId);
    expect(truncated?.state).not.toBe("up-to-date");
    expect(truncated?.checkError).toBeDefined();

    await f.gh.mutate((state) => {
      delete state.gists[gist.id];
    });
    const gone = await check(f, entry.localId);
    expect(gone?.checkError?.kind).toBe("not-found");
    expect(gone?.blockers.map((b) => b.code)).toContain("gist-not-found");
    expect(gone?.state).not.toBe("up-to-date");
  });

  it("requires exactly one pack to check GitHub", async () => {
    const f = await setup();
    await f.save(pack());
    await expect(f.service.status({ libraryRoot: "", check: true })).rejects.toThrow();
  });

  it("remembers when GitHub was last checked so a list can label it", async () => {
    const f = await setup();
    const { entry } = await linked(f);
    expect(
      (await f.service.status({ libraryRoot: "", localIds: [entry.localId], check: false }))
        .statuses[0]?.lastCheckedAt,
    ).toBeUndefined();

    await check(f, entry.localId);
    await f.gh.clearRequests();

    const cached = (
      await f.service.status({ libraryRoot: "", localIds: [entry.localId], check: false })
    ).statuses[0];
    expect(cached?.checked).toBe(false);
    expect(cached?.lastCheckedAt).toBeTruthy();
    expect(await f.gh.requests()).toEqual([]);
  });
});
