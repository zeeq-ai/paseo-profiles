import { readFile } from "node:fs/promises";
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

const fixtures: PublicationFixture[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()));
});
async function setup(options: Parameters<typeof createPublicationFixture>[0] = {}) {
  const f = await createPublicationFixture(options);
  fixtures.push(f);
  const s = scenario(f);
  const previewNew = s.previewNew.bind(s);
  // These scenarios bind and inspect an exact filename; don't depend on the suggested casing.
  s.previewNew = (localId, options = {}) => previewNew(localId, { fileName: FILE, ...options });
  return { f, s };
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
type Write = Awaited<ReturnType<PublicationFixture["gh"]["writes"]>>[number];
const filesOf = (write: Write | undefined) =>
  ((write?.body ?? {}) as { files?: Record<string, { content: string }> }).files ?? {};
const posts = async (f: PublicationFixture) =>
  (await f.gh.writes()).filter((r) => r.method === "POST");
const patches = async (f: PublicationFixture) =>
  (await f.gh.writes()).filter((r) => r.method === "PATCH");

describe("Publish as a new Gist (host-only or repository link)", () => {
  it("creates one secret Gist, then switches the link and keeps the old Gist online and untouched", async () => {
    const { f, s } = await setup();
    const entry = await f.save(pack());
    const old = await f.gh.seed({ files: { [FILE]: serializeSet(entry.set), "notes.md": "n\n" } });
    await s.link(entry.localId, { gistId: old.id, fileName: FILE });
    const before = await f.gh.gist(old.id);

    const preview = await s.previewNew(entry.localId);
    expect(preview.mode).toBe("new");
    expect(preview.target.public).toBe(false);
    expect(preview.target.description).toBeTruthy();
    expect(preview.warnings.join(" ")).toMatch(/old Gist stays online/);
    expect(preview.actions).toEqual(["publish-new"]);
    expect(preview.twoStep).toBe(false);
    await f.gh.clearRequests();

    const result = await s.commit(preview.previewId);

    expect(result.outcome).toBe("published");
    const writes = await f.gh.writes();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ method: "POST", path: "gists" });
    expect(writes[0]?.body).toMatchObject({
      public: false,
      files: { [FILE]: { content: serializeSet(entry.set) } },
    });
    expect(Object.keys(filesOf(writes[0]))).toEqual([FILE]);
    const created = result.gist;
    expect(created?.id).toBeTruthy();
    expect(created?.id).not.toBe(old.id);
    expect(created?.url).toContain(created?.id ?? "?");
    expect(await f.gh.gist(old.id)).toEqual(before);
    expect(result.status?.pointer?.gistId).toBe(created?.id);
    expect(result.status?.state).toBe("up-to-date");
    expect(result.status?.previous.map((p) => p.gistId)).toEqual([old.id]);
    // Same pack, same ID, same bytes on disk.
    expect(result.entry?.set.id).toBe(entry.set.id);
    expect(result.entry?.revision).toBe(entry.revision);
    expect((await s.status(entry.localId, true)).state).toBe("up-to-date");
  });

  it("honors a public visibility and description chosen in the review", async () => {
    const { f, s } = await setup();
    const entry = await f.save(pack());
    const preview = await s.previewNew(entry.localId, {
      public: true,
      description: "Team review profiles",
      fileName: "team.yaml",
    });
    expect(preview.target).toMatchObject({
      public: true,
      description: "Team review profiles",
      fileName: "team.yaml",
    });

    const result = await s.commit(preview.previewId);

    const gist = await f.gh.gist(result.gist?.id ?? "");
    expect(gist.public).toBe(true);
    expect(gist.description).toBe("Team review profiles");
    expect(Object.keys(gist.files)).toEqual(["team.yaml"]);
  });

  it("a read-only link to someone else's Gist can be replaced by publishing a new Gist of your own", async () => {
    const { f, s } = await setup();
    const entry = await f.save(pack());
    const jamie = await f.gh.seed({
      owner: { id: 2002, login: "jamie" },
      files: { [FILE]: serializeSet(entry.set) },
    });
    await s.link(entry.localId, { gistId: jamie.id, fileName: FILE });
    const before = await f.gh.gist(jamie.id);

    const result = await s.commit((await s.previewNew(entry.localId)).previewId);

    expect(result.outcome).toBe("published");
    expect(result.status?.ownership).toBe("owner");
    expect(result.status?.pointer?.gistId).not.toBe(jamie.id);
    expect(result.status?.previous.map((p) => p.gistId)).toEqual([jamie.id]);
    expect(await f.gh.gist(jamie.id)).toEqual(before);
    expect((await patches(f)).length).toBe(0);
  });

  it("repository storage creates the Gist, then writes the sidecar, and never embeds a pointer", async () => {
    const { f, s } = await setup();
    const repository = await f.gitRepository();
    const entry = await f.save(pack());
    const preview = await s.previewNew(entry.localId, { storage: "repository", repository });
    expect(preview.destination).toBe(sidecarPath(repository, entry.set.id));

    const result = await s.commit(preview.previewId);

    expect(result.outcome).toBe("published");
    expect(await posts(f)).toHaveLength(1);
    expect(await patches(f)).toHaveLength(0);
    const sidecar = JSON.parse(await readFile(sidecarPath(repository, entry.set.id), "utf8"));
    expect(sidecar).toMatchObject({
      packId: entry.set.id,
      gistId: result.gist?.id,
      fileName: FILE,
    });
    const remote = (await f.gh.gist(result.gist?.id ?? "")).files[FILE]?.content ?? "";
    expect(remote).not.toMatch(/^gist:/m);
    expect(result.entry?.set.gist).toBeUndefined();
  });

  it("a repeated commit of the same review, even after a restart, never POSTs again", async () => {
    const { f, s } = await setup();
    const entry = await f.save(pack());
    const preview = await s.previewNew(entry.localId);
    await f.gh.clearRequests();

    await s.commit(preview.previewId);
    await s.commit(preview.previewId);
    await scenario(f, () => f.restart()).commit(preview.previewId);

    expect(await posts(f)).toHaveLength(1);
    expect(Object.keys((await f.gh.state()).gists)).toHaveLength(1);
  });

  it("is available for an unlinked pack and the first link is the new Gist", async () => {
    const { f, s } = await setup();
    const entry = await f.save(pack());
    expect((await s.status(entry.localId)).state).toBe("unlinked");

    const result = await s.commit((await s.previewNew(entry.localId)).previewId);

    expect(result.status?.previous).toEqual([]);
    expect(result.status?.state).toBe("up-to-date");
  });
});

describe("Publish as a new Gist with the link inside the pack file", () => {
  it("POSTs without the pointer, PATCHes the new Gist to point at itself, then switches", async () => {
    const { f, s } = await setup();
    const entry = await f.save(pack());
    const old = await f.gh.seed({ files: { [FILE]: serializeSet(entry.set) } });
    await s.link(entry.localId, { gistId: old.id, fileName: FILE });
    const preview = await s.previewNew(entry.localId, { storage: "portable" });
    expect(preview.twoStep).toBe(true);
    expect(preview.upgradesPackFormat).toBe(true);
    await f.gh.clearRequests();

    const result = await s.commit(preview.previewId);

    expect(result.outcome).toBe("published");
    const writes = await f.gh.writes();
    expect(writes.map((w) => w.method)).toEqual(["POST", "PATCH"]);
    const firstFile = filesOf(writes[0])[FILE];
    expect(parseSet(firstFile?.content ?? "").set.gist).toBeUndefined();
    const newId = result.gist?.id ?? "";
    expect(writes[1]?.path).toBe(`gists/${newId}`);
    const patched = filesOf(writes[1])[FILE];
    expect(parseSet(patched?.content ?? "").set.gist).toEqual({ id: newId, file: FILE });
    expect(Object.keys(filesOf(writes[1]))).toEqual([FILE]);
    // Two remote revisions exist, the second being the completed file.
    const remote = await f.gh.gist(newId);
    expect(remote.history).toHaveLength(2);
    expect(remote.files[FILE]?.content).toBe(patched?.content);
    // Local pack now carries the same pointer; ID is unchanged; the old link is history.
    expect(result.entry?.set.id).toBe(entry.set.id);
    expect(result.entry?.set.gist).toEqual({ id: newId, file: FILE });
    expect(result.status?.pointer?.gistId).toBe(newId);
    expect(result.status?.previous.map((p) => p.gistId)).toEqual([old.id]);
    expect(result.status?.state).toBe("up-to-date");
    expect((await s.status(entry.localId, true)).state).toBe("up-to-date");
  });

  it("when the second step fails the Gist exists, the old link stays active, and Finish adds only the PATCH", async () => {
    const { f, s } = await setup();
    const entry = await f.save(pack());
    const old = await f.gh.seed({ files: { [FILE]: serializeSet(entry.set) } });
    await s.link(entry.localId, { gistId: old.id, fileName: FILE });
    const preview = await s.previewNew(entry.localId, { storage: "portable" });
    await f.gh.fault({
      match: "^PATCH /gists/",
      effect: { kind: "error", status: 502, message: "Bad Gateway" },
    });
    await f.gh.clearRequests();

    const result = await s.commit(preview.previewId);

    expect(result.outcome).toBe("link-embedding-unfinished");
    expect(result.operation?.phase).toBe("gist-created-link-unfinished");
    expect(result.operation?.nextActions).toContain("finish");
    expect(result.operation?.gist?.url).toBeTruthy();
    const newId = result.operation?.gist?.id ?? "";
    expect(newId).toBeTruthy();
    // The active link did not switch on a half-finished publication.
    const mid = await s.status(entry.localId);
    expect(mid.state).toBe("unresolved-operation");
    expect((await f.store.read(entry.localId)).set.gist).toBeUndefined();
    expect(await posts(f)).toHaveLength(1);

    // After a restart, Finish resumes without creating another Gist.
    const restarted = scenario(f, () => f.restart());
    const finished = await restarted.operation(preview.previewId, "finish");

    expect(finished.operation.status).toBe("complete");
    expect(await posts(f)).toHaveLength(1);
    expect(await patches(f)).toHaveLength(2);
    expect(finished.status?.pointer?.gistId).toBe(newId);
    expect((await f.store.read(entry.localId)).set.gist).toEqual({ id: newId, file: FILE });
    expect(Object.keys((await f.gh.state()).gists).filter((id) => id !== old.id)).toEqual([newId]);
  });

  it("a fault between the two steps leaves the same resumable state", async () => {
    const stage = { fail: true };
    const { f, s } = await setup({
      fault: (name) => {
        if (name === "gistBeforePortablePatch" && stage.fail) throw new Error("killed");
      },
    });
    const entry = await f.save(pack());
    const preview = await s.previewNew(entry.localId, { storage: "portable" });
    await f.gh.clearRequests();

    const result = await s.commit(preview.previewId);

    expect(result.outcome).toBe("link-embedding-unfinished");
    expect(await patches(f)).toHaveLength(0);
    stage.fail = false;
    const finished = await s.operation(preview.previewId, "finish");
    expect(finished.operation.status).toBe("complete");
    expect(await posts(f)).toHaveLength(1);
    expect(await patches(f)).toHaveLength(1);
  });

  it("a PATCH whose response was lost is confirmed by reading the Gist back, with no second PATCH", async () => {
    const { f, s } = await setup();
    const entry = await f.save(pack());
    const preview = await s.previewNew(entry.localId, { storage: "portable" });
    await f.gh.fault({ match: "^PATCH /gists/", applied: true, effect: { kind: "error" } });
    await f.gh.clearRequests();

    const result = await s.commit(preview.previewId);
    expect(result.outcome).toBe("link-embedding-unfinished");

    const checked = await s.operation(preview.previewId, "check");
    expect(checked.operation.status).toBe("complete");
    expect(checked.status?.state).toBe("up-to-date");
    expect(await posts(f)).toHaveLength(1);
    expect(await patches(f)).toHaveLength(1);
  });

  it("a local save failure after the completed file is finished without any further request", async () => {
    const failure = { on: true };
    const { f, s } = await setup({
      fault: (name) => {
        if (name === "gistBeforeLocalLinkSave" && failure.on) throw new Error("disk error");
      },
    });
    const entry = await f.save(pack());
    const preview = await s.previewNew(entry.localId, { storage: "portable" });
    await f.gh.clearRequests();

    const result = await s.commit(preview.previewId);

    expect(result.outcome).toBe("partial-local-save");
    expect((await f.store.read(entry.localId)).set.gist).toBeUndefined();
    failure.on = false;
    const finished = await s.operation(preview.previewId, "finish");
    expect(finished.operation.status).toBe("complete");
    expect(await f.gh.writes()).toHaveLength(2);
    expect((await f.store.read(entry.localId)).set.gist?.file).toBe(FILE);
  });
});

describe("a lost create response", () => {
  it("is never retried: the person checks, and the one matching Gist can be adopted", async () => {
    const { f, s } = await setup();
    const entry = await f.save(pack());
    const preview = await s.previewNew(entry.localId);
    await f.gh.fault({ match: "^POST /gists", applied: true, effect: { kind: "error" } });
    await f.gh.clearRequests();

    const result = await s.commit(preview.previewId);

    expect(result.outcome).toBe("outcome-unknown");
    expect(result.operation?.gist?.id).toBeUndefined();
    expect(result.operation?.nextActions).toEqual(["check", "dismiss"]);
    expect(await posts(f)).toHaveLength(1);
    // Restart, repeat the commit, and check: still exactly one POST.
    const restarted = scenario(f, () => f.restart());
    expect((await restarted.commit(preview.previewId)).outcome).toBe("outcome-unknown");
    const checked = await restarted.operation(preview.previewId, "check");
    expect(await posts(f)).toHaveLength(1);
    expect(checked.operation.candidates).toHaveLength(1);
    const candidate = checked.operation.candidates[0];
    expect(checked.operation.status).toBe("unknown");

    const adopted = await restarted.operation(preview.previewId, "adopt", {
      gistId: candidate?.gistId,
    });

    expect(adopted.operation.status).toBe("complete");
    expect(adopted.status?.pointer?.gistId).toBe(candidate?.gistId);
    expect(adopted.status?.state).toBe("up-to-date");
    expect(await posts(f)).toHaveLength(1);
  });

  it("zero candidates does not prove nothing was created; closing warns about duplicates", async () => {
    const { f, s } = await setup();
    const entry = await f.save(pack());
    const preview = await s.previewNew(entry.localId);
    await f.gh.fault({ match: "^POST /gists", applied: false, effect: { kind: "error" } });

    const result = await s.commit(preview.previewId);
    const checked = await s.operation(preview.previewId, "check");

    expect(result.outcome).toBe("outcome-unknown");
    expect(checked.operation.candidates).toEqual([]);
    expect(checked.operation.status).toBe("unknown");
    await expect(s.operation(preview.previewId, "dismiss")).rejects.toThrow(/duplicate/i);
    // While unresolved, no new publication can start.
    await expect(s.previewNew(entry.localId)).rejects.toThrow(/did not finish/);

    const closed = await s.operation(preview.previewId, "dismiss", { acceptDuplicateRisk: true });
    expect(closed.operation.phase).toBe("dismissed");
    const again = await s.commit((await s.previewNew(entry.localId)).previewId);
    expect(again.outcome).toBe("published");
  });

  it("several matches need a person to choose, and a Gist that does not exactly match cannot be adopted", async () => {
    const { f, s } = await setup();
    const entry = await f.save(pack());
    const preview = await s.previewNew(entry.localId);
    await f.gh.fault({ match: "^POST /gists", applied: true, effect: { kind: "error" } });
    await s.commit(preview.previewId);
    const text = serializeSet(entry.set);
    const lookalike = await f.gh.seed({ files: { [FILE]: text } });
    const wrongContent = await f.gh.seed({
      files: { [FILE]: serializeSet(pack({ name: "Different" })) },
    });
    const wrongPack = await f.gh.seed({ files: { [FILE]: serializeSet(pack({ id: "pack-z" })) } });
    const foreign = await f.gh.seed({
      owner: { id: 2002, login: "jamie" },
      files: { [FILE]: text },
    });

    const checked = await s.operation(preview.previewId, "check");

    const ids = checked.operation.candidates.map((c) => c.gistId);
    expect(ids).toHaveLength(2);
    expect(ids).toContain(lookalike.id);
    for (const rejected of [wrongContent.id, wrongPack.id, foreign.id])
      expect(ids).not.toContain(rejected);
    expect(checked.operation.status).toBe("unknown");
    await expect(
      s.operation(preview.previewId, "adopt", { gistId: wrongContent.id }),
    ).rejects.toThrow(/exactly match/);
    await expect(s.operation(preview.previewId, "adopt", { gistId: foreign.id })).rejects.toThrow();
    await expect(s.operation(preview.previewId, "adopt")).rejects.toThrow(/Choose/);
    expect((await s.status(entry.localId)).state).toBe("unresolved-operation");
  });

  it("a lost portable create keeps the pointer-free candidate adoptable, then Finish embeds without a new POST", async () => {
    const stage = { fail: true };
    const { f, s } = await setup({
      fault: (name) => {
        if (name === "gistAfterPortablePost" && stage.fail) throw new Error("connection dropped");
      },
    });
    const entry = await f.save(pack());
    const preview = await s.previewNew(entry.localId, { storage: "portable" });
    await f.gh.clearRequests();

    const result = await s.commit(preview.previewId);

    expect(result.outcome).toBe("outcome-unknown");
    expect(await patches(f)).toHaveLength(0);
    stage.fail = false;
    const checked = await s.operation(preview.previewId, "check");
    expect(checked.operation.candidates).toHaveLength(1);
    const id = checked.operation.candidates[0]?.gistId ?? "";

    const adopted = await s.operation(preview.previewId, "adopt", { gistId: id });
    expect(adopted.operation.phase).toBe("gist-created-link-unfinished");
    const finished = await s.operation(preview.previewId, "finish");

    expect(finished.operation.status).toBe("complete");
    expect(await posts(f)).toHaveLength(1);
    expect(await patches(f)).toHaveLength(1);
    expect((await f.store.read(entry.localId)).set.gist).toEqual({ id, file: FILE });
  });

  it("a local save failure after a confirmed create finishes without a second POST and keeps the old link until then", async () => {
    const failure = { on: true };
    const { f, s } = await setup({
      fault: (name) => {
        if (name === "gistBeforeLocalLinkSave" && failure.on) throw new Error("disk error");
      },
    });
    const entry = await f.save(pack());
    const old = await f.gh.seed({ files: { [FILE]: serializeSet(entry.set) } });
    await s.link(entry.localId, { gistId: old.id, fileName: FILE });
    const preview = await s.previewNew(entry.localId);
    await f.gh.clearRequests();

    const result = await s.commit(preview.previewId);

    expect(result.outcome).toBe("partial-local-save");
    expect(result.gist?.url).toBeTruthy();
    expect(await posts(f)).toHaveLength(1);
    failure.on = false;
    const finished = await s.operation(preview.previewId, "finish");
    expect(finished.status?.pointer?.gistId).toBe(result.gist?.id);
    expect(finished.status?.previous.map((p) => p.gistId)).toEqual([old.id]);
    expect(await posts(f)).toHaveLength(1);
  });
});
