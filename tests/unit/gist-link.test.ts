import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { sidecarPath } from "../../server/gist-link-store";
import { parseSet, serializeSet } from "../../server/yaml";
import type { ProfileSet } from "../../shared/set";
import { profile, profileSet } from "../fixtures/profile-sets";
import {
  createPublicationFixture,
  type PublicationFixture,
  scenario,
} from "../support/publication";

const run = promisify(execFile);
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
    profiles: [profile({ id: "reviewer", name: "Reviewer", model: "m1" })],
    ...overrides,
  });

describe("linking a Gist writes only the chosen local location", () => {
  it("host-only: saves a confirmed record on this host and nothing to GitHub or the pack file", async () => {
    const { f, s } = await setup();
    const entry = await f.save(pack());
    const gist = await f.gh.seed({
      files: { [FILE]: serializeSet(entry.set), "notes.md": "n\n" },
    });
    await f.gh.clearRequests();

    const {
      preview,
      status,
      entry: after,
    } = await s.link(entry.localId, {
      gistId: gist.id,
      fileName: FILE,
    });

    expect(preview.destination).toBe(f.links.recordPath(entry.localId));
    expect(preview.identical).toBe(true);
    expect(preview.warnings.join(" ")).toMatch(/Nothing is sent to GitHub/);
    expect(await f.gh.writes()).toEqual([]);
    // The pack file is byte-identical: a host-only link adds nothing to it.
    expect(after.revision).toBe(entry.revision);
    expect(status.state).toBe("up-to-date");
    expect(status.confirmed).toBe(true);
    expect(status.storage).toBe("host");
    expect(status.pointer).toEqual({ gistId: gist.id, fileName: FILE });
    const files = await f.filesUnderHome();
    expect(files.some((name) => name.endsWith(`gist-links/${entry.localId}.json`))).toBe(true);
  });

  it("repository: writes one sidecar named by the pack-ID hash and runs no Git command", async () => {
    const { f, s } = await setup();
    const repository = await f.gitRepository();
    const entry = await f.save(pack({ id: "../odd id/with slash" }));
    const gist = await f.gh.seed({ files: { [FILE]: serializeSet(entry.set) } });

    const {
      preview,
      status,
      entry: after,
    } = await s.link(entry.localId, {
      gistId: gist.id,
      fileName: FILE,
      storage: "repository",
      repository,
    });

    const expected = path.join(
      repository,
      ".paseo-profiles",
      "gists",
      `${createHash("sha256").update("../odd id/with slash").digest("hex")}.json`,
    );
    expect(preview.destination).toBe(expected);
    expect(sidecarPath(repository, entry.set.id)).toBe(expected);
    const sidecar = JSON.parse(await readFile(expected, "utf8"));
    expect(sidecar).toMatchObject({
      format: "paseo-profile-gist-link",
      packId: "../odd id/with slash",
      gistId: gist.id,
      fileName: FILE,
    });
    expect(status.storage).toBe("repository");
    expect(status.sidecarPath).toBe(expected);
    expect(after.revision).toBe(entry.revision);
    const untracked = (await run("git", ["-C", repository, "status", "--porcelain"])).stdout.trim();
    expect(untracked).toBe("?? .paseo-profiles/");
    expect(
      (await run("git", ["-C", repository, "log", "--oneline"]).catch(() => ({ stdout: "" })))
        .stdout,
    ).toBe("");
    expect(await readdir(path.join(repository, ".paseo-profiles"))).toEqual(["gists"]);
  });

  it("portable: upgrades only this pack to v2, keeps its ID, and keeps the previous version in history", async () => {
    const { f, s } = await setup();
    const entry = await f.save(pack());
    const gist = await f.gh.seed({ files: { [FILE]: serializeSet(entry.set) } });

    const preview = await s.linkPreview(entry.localId, {
      gistId: gist.id,
      fileName: FILE,
      storage: "portable",
    });
    expect(preview.upgradesPackFormat).toBe(true);
    expect(preview.minimumPluginVersion).toBeTruthy();
    expect(preview.destination).toBeUndefined();
    const { entry: after, status } = await s.link(entry.localId, {
      gistId: gist.id,
      fileName: FILE,
      storage: "portable",
    });

    expect(after.set.id).toBe(entry.set.id);
    expect(after.set.version).toBe(2);
    expect(after.set.gist).toEqual({ id: gist.id, file: FILE });
    expect(after.revision).not.toBe(entry.revision);
    const text = await readFile(path.join(f.store.root, `${entry.localId}.yaml`), "utf8");
    expect(parseSet(text).set.gist).toEqual({ id: gist.id, file: FILE });
    expect((await f.store.history(entry.localId)).versions.length).toBeGreaterThan(0);
    expect(status.storage).toBe("portable");
    // The remote file was not rewritten to add the pointer; linking sends nothing to GitHub.
    expect(await f.gh.writes()).toEqual([]);
  });

  it("a foreign Gist can be linked for updates but never published to", async () => {
    const { f, s } = await setup();
    const entry = await f.save(pack());
    const gist = await f.gh.seed({
      owner: { id: 2002, login: "jamie" },
      files: { [FILE]: serializeSet(entry.set) },
    });

    const { preview, status } = await s.link(entry.localId, { gistId: gist.id, fileName: FILE });
    expect(preview.canPublish).toBe(false);
    expect(preview.ownership).toBe("not-owner");
    const publish = await s.previewRevision(entry.localId);

    expect(status.state).toBe("up-to-date");
    expect(publish.actions).not.toContain("publish");
    expect(publish.actions).not.toContain("overwrite");
    expect(publish.actions).toContain("publish-new");
    expect(publish.ownership).toBe("not-owner");
    await expect(s.commit(publish.previewId, { confirmTarget: true })).rejects.toThrow();
    expect(await f.gh.writes()).toEqual([]);
  });

  it("a new YAML filename in an owned Gist is Pending first publish and sends nothing", async () => {
    const { f, s } = await setup();
    const entry = await f.save(pack());
    const gist = await f.gh.seed({ files: { "notes.md": "n\n" } });

    const { preview, status } = await s.link(entry.localId, {
      gistId: gist.id,
      fileName: "fresh.yaml",
    });

    expect(preview.pendingFirstPublish).toBe(true);
    expect(preview.fileExists).toBe(false);
    expect(status.state).toBe("pending-first-publish");
    expect(status.pendingFirstPublish).toBe(true);
    expect(await f.gh.writes()).toEqual([]);
    expect(Object.keys((await f.gh.gist(gist.id)).files)).toEqual(["notes.md"]);
  });

  it("cannot add a file to a Gist someone else owns, nor use a non-YAML new name", async () => {
    const { f, s } = await setup();
    const entry = await f.save(pack());
    const foreign = await f.gh.seed({
      owner: { id: 2002, login: "jamie" },
      files: { "a.md": "x\n" },
    });
    const own = await f.gh.seed({ files: { "a.md": "x\n" } });

    const blockedForeign = await s.linkPreview(entry.localId, {
      gistId: foreign.id,
      fileName: "fresh.yaml",
    });
    expect(blockedForeign.blockers.map((b) => b.code)).toContain("not-owner");
    await expect(
      f.service.linkCommit({
        libraryRoot: "",
        previewId: blockedForeign.previewId,
        confirmTarget: true,
      }),
    ).rejects.toThrow();
    const blockedName = await s.linkPreview(entry.localId, {
      gistId: own.id,
      fileName: "fresh.txt",
    });
    expect(blockedName.blockers.length).toBeGreaterThan(0);
  });

  it("refuses a file holding a different pack, an unreadable file, and a JSON file", async () => {
    const { f, s } = await setup();
    const entry = await f.save(pack());
    const gist = await f.gh.seed({
      files: {
        "other.yaml": serializeSet(pack({ id: "pack-b", name: "B" })),
        "broken.yaml": "profiles: [oops",
        "data.json": "{}",
      },
    });

    const codes = async (fileName: string) =>
      (await s.linkPreview(entry.localId, { gistId: gist.id, fileName })).blockers.map(
        (b) => b.code,
      );

    expect(await codes("other.yaml")).toContain("pack-id-mismatch");
    expect(await codes("broken.yaml")).toContain("remote-invalid");
    expect(await codes("data.json")).toContain("json-file");
    expect(await f.gh.writes()).toEqual([]);
  });

  it("shows the difference when the saved pack differs from the remote file, and links as not up to date", async () => {
    const { f, s } = await setup();
    const entry = await f.save(pack());
    const remote = pack({
      profiles: [profile({ id: "reviewer", name: "Reviewer", model: "remote" })],
    });
    const gist = await f.gh.seed({ files: { [FILE]: serializeSet(remote) } });

    const { preview, status } = await s.link(entry.localId, { gistId: gist.id, fileName: FILE });

    expect(preview.identical).toBe(false);
    expect(preview.comparison?.diff.changed).toEqual(["reviewer"]);
    // The remote file is the initial baseline, so the local pack counts as changed.
    expect(status.state).toBe("unpublished-changes");
  });

  it("rejects a commit when the Gist file changed after the review, or the pack was edited", async () => {
    const { f, s } = await setup();
    const entry = await f.save(pack());
    const gist = await f.gh.seed({ files: { [FILE]: serializeSet(entry.set) } });

    const stale = await s.linkPreview(entry.localId, { gistId: gist.id, fileName: FILE });
    await f.gh.edit(gist.id, FILE, serializeSet(pack({ name: "Edited remotely" })));
    await expect(
      f.service.linkCommit({ libraryRoot: "", previewId: stale.previewId, confirmTarget: true }),
    ).rejects.toThrow(/changed since the review/);

    const second = await s.linkPreview(entry.localId, { gistId: gist.id, fileName: FILE });
    await f.save({ ...entry.set, name: "Edited locally" }, entry.localId, entry.revision);
    await expect(
      f.service.linkCommit({ libraryRoot: "", previewId: second.previewId, confirmTarget: true }),
    ).rejects.toThrow();
    expect((await s.status(entry.localId)).state).toBe("unlinked");
  });

  it("an unrelated file edit between review and commit does not block the link", async () => {
    const { f, s } = await setup();
    const entry = await f.save(pack());
    const gist = await f.gh.seed({ files: { [FILE]: serializeSet(entry.set), "notes.md": "n\n" } });
    const preview = await s.linkPreview(entry.localId, { gistId: gist.id, fileName: FILE });
    await f.gh.edit(gist.id, "notes.md", "changed\n");

    const result = await f.service.linkCommit({
      libraryRoot: "",
      previewId: preview.previewId,
      confirmTarget: true,
    });

    expect(result.status.state).toBe("up-to-date");
  });

  it("relinking replaces the active target and remembers the old one without touching either Gist", async () => {
    const { f, s } = await setup();
    const entry = await f.save(pack());
    const first = await f.gh.seed({ files: { [FILE]: serializeSet(entry.set) } });
    const second = await f.gh.seed({ files: { [FILE]: serializeSet(entry.set) } });
    await s.link(entry.localId, { gistId: first.id, fileName: FILE });

    const { status, preview } = await s.link(entry.localId, { gistId: second.id, fileName: FILE });

    expect(preview.replaces.map((l) => l.pointer?.gistId)).toEqual([first.id]);
    expect(status.pointer?.gistId).toBe(second.id);
    expect(status.previous.map((p) => p.gistId)).toEqual([first.id]);
    expect(await f.gh.writes()).toEqual([]);
  });

  it("changing storage removes the old pointer location instead of leaving a conflict", async () => {
    const { f, s } = await setup();
    const repository = await f.gitRepository();
    const entry = await f.save(pack());
    const gist = await f.gh.seed({ files: { [FILE]: serializeSet(entry.set) } });
    await s.link(entry.localId, { gistId: gist.id, fileName: FILE, storage: "portable" });

    const { status } = await s.link(entry.localId, {
      gistId: gist.id,
      fileName: FILE,
      storage: "repository",
      repository,
    });

    expect(status.state).not.toBe("link-conflict");
    expect(status.locations.filter((l) => l.pointer)).toHaveLength(1);
    expect(status.storage).toBe("repository");
    const saved = await f.store.read(entry.localId);
    expect(saved.set.gist).toBeUndefined();
    expect(saved.set.version).toBe(1);
  });
});

describe("unlinking", () => {
  it("removes the active pointer, keeps the history, and leaves the remote Gist alone", async () => {
    const { f, s } = await setup();
    const entry = await f.save(pack());
    const gist = await f.gh.seed({ files: { [FILE]: serializeSet(entry.set) } });
    await s.link(entry.localId, { gistId: gist.id, fileName: FILE });
    const before = await f.gh.gist(gist.id);

    const { status } = await s.unlink(entry.localId);

    expect(status.state).toBe("unlinked");
    expect(status.pointer).toBeUndefined();
    expect(status.previous.map((p) => p.gistId)).toEqual([gist.id]);
    expect(status.previous[0]?.reason).toBe("unlinked");
    expect(await f.gh.gist(gist.id)).toEqual(before);
    expect(await f.gh.writes()).toEqual([]);
  });

  it("removes a portable pointer from the pack and a repository sidecar from the repo", async () => {
    const { f, s } = await setup();
    const repository = await f.gitRepository();
    const portable = await f.save(pack());
    const gistA = await f.gh.seed({ files: { [FILE]: serializeSet(portable.set) } });
    await s.link(portable.localId, { gistId: gistA.id, fileName: FILE, storage: "portable" });
    await s.unlink(portable.localId);
    const after = await f.store.read(portable.localId);
    expect(after.set.gist).toBeUndefined();
    expect(after.set.version).toBe(1);

    const repo = await f.save(pack({ id: "pack-r", name: "R" }));
    const gistB = await f.gh.seed({ files: { [FILE]: serializeSet(repo.set) } });
    await s.link(repo.localId, {
      gistId: gistB.id,
      fileName: FILE,
      storage: "repository",
      repository,
    });
    await s.unlink(repo.localId);
    await expect(readFile(sidecarPath(repository, "pack-r"), "utf8")).rejects.toThrow();
  });

  it("rejects an unlink for a pack with no link or a stale revision", async () => {
    const { f, s } = await setup();
    const entry = await f.save(pack());
    await expect(s.unlink(entry.localId)).rejects.toThrow(/no Gist link/);
    await expect(
      f.service.unlink({ libraryRoot: "", localId: entry.localId, expectedRevision: "stale" }),
    ).rejects.toThrow();
  });
});

describe("a repository sidecar shared through Git is untrusted until confirmed here", () => {
  it("a sidecar changed by another clone is not silently followed", async () => {
    const { f, s } = await setup();
    const repository = await f.gitRepository();
    const entry = await f.save(pack());
    const mine = await f.gh.seed({ files: { [FILE]: serializeSet(entry.set) } });
    const theirs = await f.gh.seed({
      files: { [FILE]: serializeSet(pack({ name: "Teammate version" })) },
    });
    await s.link(entry.localId, {
      gistId: mine.id,
      fileName: FILE,
      storage: "repository",
      repository,
    });
    expect((await s.status(entry.localId)).state).toBe("up-to-date");

    // `git pull` brings a teammate's version of the sidecar.
    const file = sidecarPath(repository, entry.set.id);
    const sidecar = JSON.parse(await readFile(file, "utf8"));
    await writeFile(
      file,
      JSON.stringify({ ...sidecar, gistId: theirs.id, lastConfirmedRevision: "f".repeat(40) }),
    );

    const status = await s.status(entry.localId, true);
    expect(status.pointer?.gistId).toBe(theirs.id);
    expect(status.confirmed).toBe(false);
    expect(status.state).toBe("needs-confirmation");
    const preview = await s.previewRevision(entry.localId);
    expect(preview.requiresTargetConfirmation).toBe(true);
    await expect(s.commit(preview.previewId)).rejects.toThrow(/Confirm the Gist target/);
    expect(await f.gh.writes()).toEqual([]);
  });

  it("a sidecar claiming another pack is reported as a problem, not followed", async () => {
    const { f, s } = await setup();
    const repository = await f.gitRepository();
    const entry = await f.save(pack());
    const gist = await f.gh.seed({ files: { [FILE]: serializeSet(entry.set) } });
    await s.link(entry.localId, {
      gistId: gist.id,
      fileName: FILE,
      storage: "repository",
      repository,
    });
    const file = sidecarPath(repository, entry.set.id);
    const sidecar = JSON.parse(await readFile(file, "utf8"));
    await writeFile(file, JSON.stringify({ ...sidecar, packId: "someone-else" }));

    const status = await s.status(entry.localId);

    expect(status.pointer).toBeUndefined();
    expect(status.locations.find((l) => l.location === "repository")?.problem).toBeTruthy();
    expect(status.state).not.toBe("up-to-date");
  });

  it("a preview for a repository that already has a sidecar reports it", async () => {
    const { f, s } = await setup();
    const repository = await f.gitRepository();
    const entry = await f.save(pack());
    const first = await f.gh.seed({ files: { [FILE]: serializeSet(entry.set) } });
    const second = await f.gh.seed({ files: { [FILE]: serializeSet(entry.set) } });
    await s.link(entry.localId, {
      gistId: first.id,
      fileName: FILE,
      storage: "repository",
      repository,
    });
    await s.unlink(entry.localId).catch(() => undefined);
    await writeFile(
      sidecarPath(repository, entry.set.id),
      JSON.stringify({
        format: "paseo-profile-gist-link",
        version: 1,
        packId: entry.set.id,
        gistId: first.id,
        fileName: FILE,
      }),
    );

    const preview = await s.linkPreview(entry.localId, {
      gistId: second.id,
      fileName: FILE,
      storage: "repository",
      repository,
    });

    expect(preview.existingSidecar).toEqual({ gistId: first.id, fileName: FILE });
  });
});
