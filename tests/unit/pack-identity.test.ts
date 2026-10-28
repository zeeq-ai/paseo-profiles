import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseSet } from "../../server/yaml";
import { type ProfileSet, SetSchema } from "../../shared/set";
import { profile, profileSet } from "../fixtures/profile-sets";
import { createServiceFixture, type ServiceFixture } from "../support/profile-service";

const fixtures: ServiceFixture[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()));
});

const POINTER = { id: "3f9ac21e", file: "fast-review.yaml" };
const linkedSet = (overrides: Partial<ProfileSet> = {}): ProfileSet =>
  SetSchema.parse({
    ...profileSet({
      id: "2dbfbd3d-81eb-4ab2-90a4-45dd2ef67e2b",
      name: "Fast review",
      profiles: [
        profile({ id: "reviewer", name: "Reviewer" }),
        profile({ id: "tester", name: "Tester" }),
      ],
    }),
    version: 2,
    gist: POINTER,
    ...overrides,
  });

async function setup(profiles = [profile({ id: "reviewer", name: "Reviewer" })]) {
  const fixture = await createServiceFixture({ profiles });
  fixtures.push(fixture);
  return fixture;
}
async function onDisk(fixture: ServiceFixture, localId: string) {
  const text = await readFile(
    path.join(fixture.home, "plugin-data/paseo-profiles/sets", `${localId}.yaml`),
    "utf8",
  );
  return { text, set: parseSet(text).set };
}

describe("pack ID is the stable lineage; copies mint a new one and drop the link", () => {
  it("keeps the ID and a portable link across an ordinary edit", async () => {
    const { service } = await setup();
    const saved = await service.saveSet({ libraryRoot: "", set: linkedSet() });

    const edited = await service.saveSet({
      libraryRoot: "",
      localId: saved.localId,
      expectedRevision: saved.revision,
      set: { ...saved.set, name: "Fast review 2" },
    });

    expect(edited.set.id).toBe(saved.set.id);
    expect(edited.set.gist).toEqual(POINTER);
  });

  it("rejects replacing an existing pack with a set that has another ID", async () => {
    const { service } = await setup();
    const saved = await service.saveSet({ libraryRoot: "", set: linkedSet() });

    await expect(
      service.saveSet({
        libraryRoot: "",
        localId: saved.localId,
        expectedRevision: saved.revision,
        set: { ...saved.set, id: "someone-elses-pack" },
      }),
    ).rejects.toThrow();
    expect((await service.readSet({ libraryRoot: "", localId: saved.localId })).set.id).toBe(
      saved.set.id,
    );
  });

  it("Duplicate mints a new ID, records the source, and strips the portable link", async () => {
    const fixture = await setup();
    const saved = await fixture.service.saveSet({ libraryRoot: "", set: linkedSet() });

    const copy = await fixture.service.duplicateSet({
      libraryRoot: "",
      localId: saved.localId,
      expectedRevision: saved.revision,
      name: "Fast review copy",
    });

    expect(copy.set.id).not.toBe(saved.set.id);
    expect(copy.set.copiedFrom).toBe(saved.set.id);
    expect(copy.set.gist).toBeUndefined();
    const stored = await onDisk(fixture, copy.localId);
    expect(stored.text).not.toMatch(/^gist:/m);
    expect(stored.set.gist).toBeUndefined();
    // The source keeps its link.
    expect(
      (await fixture.service.readSet({ libraryRoot: "", localId: saved.localId })).set.gist,
    ).toEqual(POINTER);
  });

  it("a full-pack library export carries the portable link and the same ID", async () => {
    const { service } = await setup();
    const saved = await service.saveSet({ libraryRoot: "", set: linkedSet() });

    const { files } = await service.exportProfiles({
      source: "library",
      libraryRoot: "",
      localIds: [saved.localId],
      excludeGistLink: false,
    });

    const exported = parseSet(files[0]?.text ?? "").set;
    expect(exported.id).toBe(saved.set.id);
    expect(exported.gist).toEqual(POINTER);
  });

  it("excluding the update link removes only the pointer", async () => {
    const { service } = await setup();
    const saved = await service.saveSet({ libraryRoot: "", set: linkedSet() });

    const { files } = await service.exportProfiles({
      source: "library",
      libraryRoot: "",
      localIds: [saved.localId],
      excludeGistLink: true,
    });

    const exported = parseSet(files[0]?.text ?? "").set;
    expect(exported.gist).toBeUndefined();
    expect(exported.profiles).toEqual(saved.set.profiles);
    expect(files[0]?.text).not.toMatch(/^gist:/m);
  });

  it("a subset export is a new pack: new ID, copiedFrom, no link", async () => {
    const { service } = await setup();
    const saved = await service.saveSet({ libraryRoot: "", set: linkedSet() });

    const { files } = await service.exportProfiles({
      source: "library",
      libraryRoot: "",
      localIds: [saved.localId],
      profileIds: ["reviewer"],
      excludeGistLink: false,
    });

    const exported = parseSet(files[0]?.text ?? "").set;
    expect(exported.id).not.toBe(saved.set.id);
    expect(exported.copiedFrom).toBe(saved.set.id);
    expect(exported.gist).toBeUndefined();
    expect(exported.profiles.map((p) => p.id)).toEqual(["reviewer"]);
  });

  it("re-capturing the live profiles into a saved pack keeps its ID and its link", async () => {
    const fixture = await setup([
      profile({ id: "reviewer", name: "Reviewer", model: "new-model" }),
    ]);
    const saved = await fixture.service.saveSet({ libraryRoot: "", set: linkedSet() });
    const current = await fixture.service.currentProfiles();

    const recaptured = await fixture.service.captureCurrent({
      libraryRoot: "",
      localId: saved.localId,
      expectedRevision: saved.revision,
      name: saved.set.name,
      profileIds: ["reviewer"],
      expectedCurrentRevision: current.revision,
    } as Parameters<typeof fixture.service.captureCurrent>[0]);

    expect(recaptured.set.id).toBe(saved.set.id);
    expect(recaptured.set.gist).toEqual(POINTER);
    expect(recaptured.set.profiles[0]).toMatchObject({ model: "new-model" });
  });

  it("Import as copy gives a new ID and does not inherit the source's Gist pointer", async () => {
    const { service } = await setup();
    const text = (await import("../../server/yaml")).serializeSet(linkedSet());

    const preview = await service.importPreview({
      libraryRoot: "",
      files: [{ name: "fast-review.yaml", text }],
      asCopy: true,
    });
    const result = await service.importCommit({
      libraryRoot: "",
      previewId: preview.previewId,
    } as Parameters<typeof service.importCommit>[0]);

    const entry = result.entries[0];
    expect(entry?.set.id).not.toBe(linkedSet().id);
    expect(entry?.set.copiedFrom).toBe(linkedSet().id);
    expect(entry?.set.gist).toBeUndefined();
  });

  it("importing a differently-identified file onto a saved pack never changes that pack's ID", async () => {
    const { service } = await setup();
    const saved = await service.saveSet({ libraryRoot: "", set: profileSet({ id: "mine" }) });
    const text = (await import("../../server/yaml")).serializeSet(
      profileSet({ id: "theirs", name: "Their pack" }),
    );

    const outcome = await service
      .importPreview({
        libraryRoot: "",
        files: [{ name: "theirs.yaml", text }],
        targetLocalId: saved.localId,
        asCopy: false,
      })
      .then((preview) =>
        service.importCommit({ libraryRoot: "", previewId: preview.previewId } as Parameters<
          typeof service.importCommit
        >[0]),
      )
      .catch((error: Error) => error);

    const after = await service.readSet({ libraryRoot: "", localId: saved.localId });
    expect(after.set.id).toBe("mine");
    if (!(outcome instanceof Error)) expect(outcome.entries[0]?.set.id).toBe("mine");
  });
});
