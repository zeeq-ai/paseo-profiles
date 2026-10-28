import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { serializeSet } from "../../server/yaml";
import type { ProfileSet } from "../../shared/set";
import { profile, profileSet } from "../fixtures/profile-sets";
import {
  createPublicationFixture,
  type PublicationFixture,
  scenario,
} from "../support/publication";

const fixtures: PublicationFixture[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()));
});
async function setup(options: Parameters<typeof createPublicationFixture>[0] = {}) {
  const f = await createPublicationFixture(options);
  fixtures.push(f);
  return { f, s: scenario(f) };
}

const FILE = "fast-review.yaml";
const pack = (overrides: Partial<ProfileSet> = {}) =>
  profileSet({
    id: "pack-a",
    name: "Fast review",
    appendSystemPrompt: "Shared prompt.\n",
    profiles: [profile({ id: "reviewer", name: "Reviewer", model: "m1" })],
    ...overrides,
  });
const sha = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;

/** A saved pack linked and confirmed against an owned Gist with an unrelated second file. */
async function published(f: PublicationFixture, s: ReturnType<typeof scenario>) {
  const entry = await f.save(pack());
  const gist = await f.gh.seed({
    description: "My packs",
    files: { [FILE]: serializeSet(entry.set), "notes.md": "unrelated\n" },
  });
  await s.link(entry.localId, { gistId: gist.id, fileName: FILE });
  return { entry, gist };
}
const edit = async (f: PublicationFixture, localId: string, overrides: Partial<ProfileSet>) => {
  const current = await f.store.read(localId);
  return f.save({ ...current.set, ...overrides }, localId, current.revision);
};

describe("publish a revision", () => {
  it("a local edit publishes with one PATCH of the bound file's content and nothing else", async () => {
    const { f, s } = await setup();
    const { entry, gist } = await published(f, s);
    const edited = await edit(f, entry.localId, { name: "Fast review v2" });
    const preview = await s.previewRevision(entry.localId);
    expect(preview.state).toBe("unpublished-changes");
    expect(preview.primaryAction).toBe("publish");
    expect(preview.requiresOverwrite).toBe(false);
    expect(preview.otherFileCount).toBe(1);
    expect(preview.replace?.nameChanged).toEqual({
      before: "Fast review",
      target: "Fast review v2",
    });
    await f.gh.clearRequests();

    const result = await s.commit(preview.previewId);

    expect(result.outcome).toBe("published");
    const writes = await f.gh.writes();
    expect(writes).toHaveLength(1);
    expect(writes[0]?.method).toBe("PATCH");
    expect(writes[0]?.path).toBe(`gists/${gist.id}`);
    const body = writes[0]?.body as { files: Record<string, { content: string }> };
    expect(Object.keys(body)).toEqual(["files"]);
    expect(Object.keys(body.files)).toEqual([FILE]);
    const after = await f.gh.gist(gist.id);
    expect(after.files["notes.md"]?.content).toBe("unrelated\n");
    expect(after.description).toBe("My packs");
    expect(after.files[FILE]?.content).toBe(serializeSet(edited.set));
    expect(after.history).toHaveLength(2);
    // The saved pack is not rewritten by a host-only publish, and the baseline records the new file.
    expect((await f.store.read(entry.localId)).revision).toBe(edited.revision);
    expect(result.status?.state).toBe("up-to-date");
    expect(result.status?.baseline?.fileHash).toBe(sha(serializeSet(edited.set)));
    expect(result.status?.baseline?.revision).toBe(after.history[0]?.version);
    expect(result.gist?.revision).toBe(after.history[0]?.version);
    expect((await s.status(entry.localId, true)).state).toBe("up-to-date");
  });

  it("never touches the live daemon profiles", async () => {
    const { f, s } = await setup();
    const { entry } = await published(f, s);
    await edit(f, entry.localId, { name: "v2" });
    const preview = await s.previewRevision(entry.localId);
    await s.commit(preview.previewId);
    // Publication only ever talks to GitHub and the library; the fake gh saw no profile data
    // other than the pack file.
    const writes = await f.gh.writes();
    expect(JSON.stringify(writes)).not.toMatch(/agentProfiles/);
  });

  it("an unchanged pack offers no revision to publish", async () => {
    const { f, s } = await setup();
    const { entry } = await published(f, s);
    const preview = await s.previewRevision(entry.localId);

    expect(preview.state).toBe("up-to-date");
    expect(preview.actions).not.toContain("publish");
    await expect(s.commit(preview.previewId, { confirmTarget: true })).rejects.toThrow();
    expect(await f.gh.writes()).toEqual([]);
  });

  it("a remote edit requires an explicit overwrite, and a plain commit writes nothing", async () => {
    const { f, s } = await setup();
    const { entry, gist } = await published(f, s);
    const remoteText = serializeSet(pack({ name: "Edited on GitHub" }));
    await f.gh.edit(gist.id, FILE, remoteText);
    const preview = await s.previewRevision(entry.localId);

    expect(preview.state).toBe("remote-changed");
    expect(preview.actions).toEqual(["overwrite", "replace-saved-pack", "publish-new"]);
    expect(preview.requiresOverwrite).toBe(true);
    expect(preview.remoteChange?.target.length).toBeGreaterThan(0);
    await f.gh.clearRequests();
    await expect(s.commit(preview.previewId)).rejects.toThrow(/overwrite/i);
    expect(await f.gh.writes()).toEqual([]);

    const result = await s.commit(preview.previewId, { overwriteRemote: true });
    expect(result.outcome).toBe("published");
    expect((await f.gh.gist(gist.id)).files[FILE]?.content).toBe(serializeSet(entry.set));
  });

  it("when both sides changed it shows both directions and keeps the same three choices", async () => {
    const { f, s } = await setup();
    const { entry, gist } = await published(f, s);
    await f.gh.edit(gist.id, FILE, serializeSet(pack({ name: "Remote rename" })));
    await edit(f, entry.localId, {
      profiles: [profile({ id: "reviewer", name: "Reviewer", model: "local-model" })],
    });

    const preview = await s.previewRevision(entry.localId);

    expect(preview.state).toBe("both-changed");
    expect(preview.localChanged && preview.remoteChanged).toBe(true);
    expect(preview.localChange?.diff.changed).toEqual(["reviewer"]);
    expect(preview.remoteChange?.nameChanged?.target).toBe("Remote rename");
    expect(preview.actions).toEqual(["overwrite", "replace-saved-pack", "publish-new"]);
  });

  it("a remote change between review and commit returns to review without writing", async () => {
    const { f, s } = await setup();
    const { entry, gist } = await published(f, s);
    await edit(f, entry.localId, { name: "v2" });
    const preview = await s.previewRevision(entry.localId);
    await f.gh.edit(gist.id, FILE, serializeSet(pack({ name: "Raced in" })));
    await f.gh.clearRequests();

    const result = await s.commit(preview.previewId);

    expect(result.outcome).toBe("remote-changed");
    expect(await f.gh.writes()).toEqual([]);
    expect((await f.gh.gist(gist.id)).files[FILE]?.content).toBe(
      serializeSet(pack({ name: "Raced in" })),
    );
    // A fresh review shows the new difference.
    expect((await s.previewRevision(entry.localId)).state).toBe("both-changed");
  });

  it("an unrelated Gist file changing after the review is not a conflict", async () => {
    const { f, s } = await setup();
    const { entry, gist } = await published(f, s);
    await edit(f, entry.localId, { name: "v2" });
    const preview = await s.previewRevision(entry.localId);
    await f.gh.edit(gist.id, "notes.md", "someone edited the notes\n");
    await f.gh.edit(gist.id, "extra.txt", "and added a file\n");

    const result = await s.commit(preview.previewId);

    expect(result.outcome).toBe("published");
    const after = await f.gh.gist(gist.id);
    expect(after.files["notes.md"]?.content).toBe("someone edited the notes\n");
    expect(after.files["extra.txt"]?.content).toBe("and added a file\n");
  });

  it("accepts last-write-wins for an edit that lands after the final reread, and GitHub keeps it in history", async () => {
    const { f, s } = await setup();
    const { entry, gist } = await published(f, s);
    const edited = await edit(f, entry.localId, { name: "v2" });
    const preview = await s.previewRevision(entry.localId);
    // The concurrent writer lands just before the PATCH, after the service's final reread.
    await f.gh.sideEffect({
      match: "^PATCH /gists/",
      edit: { gistId: gist.id, file: FILE, content: serializeSet(pack({ name: "Slipped in" })) },
    });

    const result = await s.commit(preview.previewId);

    expect(result.outcome).toBe("published");
    const after = await f.gh.gist(gist.id);
    expect(after.files[FILE]?.content).toBe(serializeSet(edited.set));
    expect(after.history.map((h) => h.files[FILE])).toContain(
      serializeSet(pack({ name: "Slipped in" })),
    );
    // The next check does not claim the slipped-in edit never happened.
    expect((await s.status(entry.localId, true)).state).toBe("up-to-date");
  });

  it("identical remote content with a stale baseline refreshes the baseline without any write", async () => {
    const { f, s } = await setup();
    const { entry, gist } = await published(f, s);
    const edited = await edit(f, entry.localId, { name: "v2" });
    // The same edit was made on GitHub by hand.
    await f.gh.edit(gist.id, FILE, serializeSet(edited.set));
    const preview = await s.previewRevision(entry.localId);

    expect(preview.alreadyEqual).toBe(true);
    expect(preview.state).toBe("baseline-refresh");
    expect(preview.primaryAction).toBe("refresh-baseline");
    expect(preview.actions).not.toContain("publish");
    await f.gh.clearRequests();
    await expect(s.commit(preview.previewId)).rejects.toThrow();

    const result = await s.commit(preview.previewId, { refreshBaselineOnly: true });
    expect(await f.gh.writes()).toEqual([]);
    expect(result.status?.state).toBe("up-to-date");
    expect(result.status?.baseline?.fileHash).toBe(sha(serializeSet(edited.set)));
  });

  it("a Gist owned by someone else offers review-updates and publish-new, never an in-place write", async () => {
    const { f, s } = await setup();
    const entry = await f.save(pack());
    const gist = await f.gh.seed({
      owner: { id: 2002, login: "jamie" },
      files: { [FILE]: serializeSet(pack({ name: "Jamie's update" })) },
    });
    await s.link(entry.localId, { gistId: gist.id, fileName: FILE });

    const preview = await s.previewRevision(entry.localId);

    expect(preview.actions).toEqual(["review-updates", "publish-new"]);
    expect(preview.ownership).toBe("not-owner");
    await expect(
      s.commit(preview.previewId, { overwriteRemote: true, confirmTarget: true }),
    ).rejects.toThrow();
    expect(await f.gh.writes()).toEqual([]);
  });

  it("blocks when the bound file vanished or now holds another pack, offering only a new Gist", async () => {
    const { f, s } = await setup();
    const { entry, gist } = await published(f, s);
    await edit(f, entry.localId, { name: "v2" });
    await f.gh.edit(gist.id, FILE, null);
    const missing = await s.previewRevision(entry.localId);
    expect(missing.state).toBe("blocked");
    expect(missing.actions).toEqual(["publish-new"]);
    expect(missing.blockers.map((b) => b.code)).toContain("file-missing");
    await expect(
      s.commit(missing.previewId, { overwriteRemote: true, confirmTarget: true }),
    ).rejects.toThrow();

    await f.gh.edit(gist.id, FILE, serializeSet(pack({ id: "someone-elses", name: "Theirs" })));
    const other = await s.previewRevision(entry.localId);
    expect(other.state).toBe("blocked");
    expect(other.actions).not.toContain("publish");
    expect(other.actions).not.toContain("overwrite");
    expect(await f.gh.writes()).toEqual([]);
    expect(Object.keys((await f.gh.gist(gist.id)).files)).not.toContain(
      FILE.replace("fast", "zzz"),
    );
  });

  it("a Pending first publish adds the new file and leaves the others alone", async () => {
    const { f, s } = await setup();
    const entry = await f.save(pack());
    const gist = await f.gh.seed({ files: { "notes.md": "n\n" } });
    await s.link(entry.localId, { gistId: gist.id, fileName: "fresh.yaml" });
    const preview = await s.previewRevision(entry.localId);
    expect(preview.state).toBe("pending-first-publish");
    expect(preview.actions).toContain("publish");

    const result = await s.commit(preview.previewId);

    expect(result.outcome).toBe("published");
    const after = await f.gh.gist(gist.id);
    expect(Object.keys(after.files).sort()).toEqual(["fresh.yaml", "notes.md"]);
    expect(after.files["fresh.yaml"]?.content).toBe(serializeSet(entry.set));
    expect(result.status?.pendingFirstPublish).toBe(false);
  });

  it("an untrusted pointer needs explicit target confirmation before any write", async () => {
    const { f, s } = await setup();
    const plain = await f.save(pack({ id: "pack-copied" }));
    const gist = await f.gh.seed({
      files: { [FILE]: serializeSet(pack({ id: "pack-copied", name: "Older" })) },
    });
    // A pointer that arrived with a copied pack and was never confirmed on this host.
    await f.save(
      { ...plain.set, version: 2, gist: { id: gist.id, file: FILE } },
      plain.localId,
      plain.revision,
    );
    const preview = await s.previewRevision(plain.localId);

    expect(preview.requiresTargetConfirmation).toBe(true);
    await expect(s.commit(preview.previewId, { overwriteRemote: true })).rejects.toThrow(/Confirm/);
    expect(await f.gh.writes()).toEqual([]);
  });

  it("a repeated commit of the same review returns the first result and writes once", async () => {
    const { f, s } = await setup();
    const { entry } = await published(f, s);
    await edit(f, entry.localId, { name: "v2" });
    const preview = await s.previewRevision(entry.localId);
    await f.gh.clearRequests();

    const first = await s.commit(preview.previewId);
    const second = await s.commit(preview.previewId);
    const restarted = await scenario(f, () => f.restart()).commit(preview.previewId);

    expect(first.outcome).toBe("published");
    expect(second.outcome).toBe("published");
    expect(restarted.outcome).toBe("published");
    expect(await f.gh.writes()).toHaveLength(1);
  });

  it("refuses a commit when the host's GitHub account changed since the review", async () => {
    const { f, s } = await setup();
    const { entry } = await published(f, s);
    await edit(f, entry.localId, { name: "v2" });
    const preview = await s.previewRevision(entry.localId);
    await f.gh.mutate((state) => {
      state.tokens.other = { id: 4004, login: "other" };
    });
    vi.stubEnv("GH_TOKEN", "other");

    await expect(s.commit(preview.previewId)).rejects.toThrow(/account/i);
    expect(await f.gh.writes()).toEqual([]);
  });

  it("a stale review (pack edited after it) is rejected without writing", async () => {
    const { f, s } = await setup();
    const { entry } = await published(f, s);
    await edit(f, entry.localId, { name: "v2" });
    const preview = await s.previewRevision(entry.localId);
    await edit(f, entry.localId, { name: "v3" });

    await expect(s.commit(preview.previewId)).rejects.toThrow(/changed since the review/);
    expect(await f.gh.writes()).toEqual([]);
  });
});

describe("publication state is kept apart from import provenance and from exports", () => {
  it("publishing leaves the import baseline untouched and import changes leave the publication baseline alone", async () => {
    const { f, s } = await setup();
    const entry = await f.save(pack());
    const gist = await f.gh.seed({ files: { [FILE]: serializeSet(entry.set) } });
    await s.link(entry.localId, { gistId: gist.id, fileName: FILE });
    const importMetadata = {
      sourceSetId: "jamie-source",
      baseline: pack({ id: "jamie-source", name: "Jamie's pack" }),
      baselineHash: "sha256:jamie",
    };
    await f.store.locked(() => f.store.setMetadataUnlocked(entry.localId, importMetadata));
    await edit(f, entry.localId, { name: "v2" });
    const preview = await s.previewRevision(entry.localId);

    const result = await s.commit(preview.previewId);

    expect(await f.store.metadata(entry.localId)).toEqual(importMetadata);
    const published = result.status?.baseline;
    expect(published?.source).toBe("published");

    await f.store.locked(() =>
      f.store.setMetadataUnlocked(entry.localId, {
        ...importMetadata,
        baselineHash: "sha256:newer",
      }),
    );
    expect((await s.status(entry.localId)).baseline).toEqual(published);
  });

  it("a host-only link, baseline and operation journal never appear in the pack file", async () => {
    const { f, s } = await setup();
    const { entry } = await published(f, s);
    await edit(f, entry.localId, { name: "v2" });
    await f.gh.fault({ match: "^PATCH /gists/", applied: true, effect: { kind: "error" } });
    const preview = await s.previewRevision(entry.localId);
    await s.commit(preview.previewId);

    const packFile = await readFile(path.join(f.store.root, `${entry.localId}.yaml`), "utf8");
    expect(packFile).not.toMatch(/gist|journal|baseline|operation|lastConfirmed|payloadHash/i);
    const files = await f.filesUnderHome();
    expect(files.some((name) => name.includes("gist-operations"))).toBe(true);
  });
});
