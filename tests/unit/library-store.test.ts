import { mkdtemp, readdir, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LibraryStore } from "../../server/library-store";
import { profile, profileSet } from "../fixtures/profile-sets";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createStore(fault?: (stage: string) => void) {
  const home = await mkdtemp(path.join(tmpdir(), "paseo-profiles-library-"));
  roots.push(home);
  return { home, store: new LibraryStore({ home, fault }) };
}

describe("external profile-set library", () => {
  it("survives a new store instance and keeps custom-root provenance separate", async () => {
    const { home, store } = await createStore();
    const saved = await store.save(profileSet());
    const reopened = new LibraryStore({ home });
    const otherRoot = new LibraryStore({ home, root: path.join(home, "other-library") });

    expect(await reopened.read(saved.localId)).toEqual(saved);
    expect((await otherRoot.list()).entries).toEqual([]);
    expect(otherRoot.state).not.toBe(reopened.state);
  });

  it("rejects a stale revision without replacing the current head", async () => {
    const { store } = await createStore();
    const saved = await store.save(profileSet());
    const updated = profileSet({ profiles: [profile({ id: "new", name: "New version" })] });
    const current = await store.save(updated, saved.localId, saved.revision);

    await expect(store.save(profileSet(), saved.localId, saved.revision)).rejects.toThrow(
      "Saved pack changed since the preview",
    );
    expect(await store.read(saved.localId)).toEqual(current);
  });

  it("keeps the previous version available and restores it through a new revision", async () => {
    const { store } = await createStore();
    const initial = await store.save(profileSet());
    const updated = await store.save(
      profileSet({
        name: "Jamie Engineering 2",
        profiles: [profile({ id: "review", name: "Review", notes: "Updated" })],
      }),
      initial.localId,
      initial.revision,
    );

    const history = await store.history(initial.localId);
    const oldVersion = history.versions.find((version) => version.name === initial.set.name);
    expect(oldVersion).toBeDefined();
    if (!oldVersion) throw new Error("The previous saved set is missing from history");

    const restored = await store.restore(initial.localId, oldVersion.revision, updated.revision);
    expect(restored.set).toEqual(initial.set);
    expect(restored.revision).toBe(initial.revision);
  });

  it("recovers a head committed before import metadata was written", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paseo-profiles-library-alias-"));
    roots.push(root);
    const alias = path.join(root, "home-alias");
    await symlink(root, alias, "dir");
    const home = path.join(alias, ".paseo");
    const initialStore = new LibraryStore({ home });
    const initial = await initialStore.save(profileSet());
    const incoming = profileSet({ name: "Updated by Jamie" });
    const metadata = {
      sourceSetId: incoming.id,
      originFingerprint: incoming.origin?.fingerprint,
      baseline: incoming,
      baselineHash: "sha256:baseline",
    };
    const interruptedStore = new LibraryStore({
      home,
      fault: (stage) => {
        if (stage === "beforeMetadataWrite") throw new Error("simulated interruption");
      },
    });

    await expect(
      interruptedStore.save(incoming, initial.localId, initial.revision, metadata),
    ).rejects.toThrow("simulated interruption");

    const recoveredStore = new LibraryStore({ home });
    await recoveredStore.recoverLibrary();
    expect((await recoveredStore.read(initial.localId)).set).toEqual(incoming);
    expect(await recoveredStore.metadata(initial.localId)).toEqual(metadata);
    expect((await recoveredStore.history(initial.localId)).versions).toContainEqual(
      expect.objectContaining({ name: profileSet().name }),
    );
  });

  it("advances import metadata without rewriting a head that already matches the source", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "paseo-profiles-metadata-only-"));
    roots.push(home);
    const initialStore = new LibraryStore({ home });
    const initial = await initialStore.save(profileSet());
    let headWrites = 0;
    const store = new LibraryStore({
      home,
      fault: (stage) => {
        if (stage === "beforeHeadWrite") headWrites += 1;
      },
    });
    const nextBaseline = profileSet({
      name: "Jamie Engineering",
      profiles: [
        profile({ id: "engineering-review", name: "Engineering review", notes: "Jamie v2" }),
      ],
    });
    const metadata = {
      sourceSetId: nextBaseline.id,
      originFingerprint: nextBaseline.origin?.fingerprint,
      baseline: nextBaseline,
      baselineHash: "sha256:next-baseline",
    };

    await store.locked(() => store.setMetadataUnlocked(initial.localId, metadata));

    expect(await store.read(initial.localId)).toEqual(initial);
    expect(await store.metadata(initial.localId)).toEqual(metadata);
    expect(headWrites).toBe(0);
  });

  it("keeps a previous head intact when a write is interrupted before publication", async () => {
    const { home } = await createStore();
    const store = new LibraryStore({ home });
    const initial = await store.save(profileSet());
    const interrupted = new LibraryStore({
      home,
      fault: (stage) => {
        if (stage === "beforeHeadWrite") throw new Error("simulated interruption");
      },
    });
    const next = profileSet({ name: "Unpublished version" });

    await expect(interrupted.save(next, initial.localId, initial.revision)).rejects.toThrow(
      "simulated interruption",
    );
    await interrupted.recoverLibrary();

    expect((await interrupted.read(initial.localId)).set).toEqual(initial.set);
  });

  it("does not replay a terminal failed-before-head journal over later metadata", async () => {
    const { home } = await createStore();
    const store = new LibraryStore({ home });
    const initialSet = profileSet({ id: "stable-head" });
    const initialMetadata = {
      sourceSetId: "initial-source",
      baseline: initialSet,
      baselineHash: "sha256:initial",
    };
    const initial = await store.save(initialSet, undefined, undefined, initialMetadata);
    const failedSet = profileSet({ id: "stable-head", name: "Failed update" });
    const failedMetadata = {
      sourceSetId: "failed-source",
      baseline: failedSet,
      baselineHash: "sha256:failed",
    };
    const interrupted = new LibraryStore({
      home,
      fault: (stage) => {
        if (stage === "beforeHeadWrite") throw new Error("head publication interrupted");
      },
    });

    await expect(
      interrupted.save(failedSet, initial.localId, initial.revision, failedMetadata),
    ).rejects.toThrow("head publication interrupted");

    const laterMetadata = {
      sourceSetId: "later-source",
      baseline: profileSet({ id: "later-source", name: "Later metadata" }),
      baselineHash: "sha256:later",
    };
    const recovered = new LibraryStore({ home });
    await recovered.locked(() => recovered.setMetadataUnlocked(initial.localId, laterMetadata));
    await recovered.recoverLibrary();

    expect(await recovered.read(initial.localId)).toEqual(initial);
    expect(await recovered.metadata(initial.localId)).toEqual(laterMetadata);
    const journalDirectory = path.join(recovered.state, "library-operations");
    const journals = await Promise.all(
      (await readdir(journalDirectory)).map(async (name) =>
        JSON.parse(await readFile(path.join(journalDirectory, name), "utf8")),
      ),
    );
    expect(
      journals.find((journal) => journal.metadata?.sourceSetId === "failed-source")?.status,
    ).toBe("not-applied");
  });
});
