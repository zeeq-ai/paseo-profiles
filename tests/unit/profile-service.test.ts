import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Fault } from "../../server/files";
import { type PaseoAdapter, ProfileService } from "../../server/profile-service";
import { serializeSet } from "../../server/yaml";
import type { Profile, ProfileSet } from "../../shared/set";
import { profile, profileSet } from "../fixtures/profile-sets";

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

function createPaseo(initialProfiles: Profile[] = []) {
  const state: {
    config: Record<string, unknown>;
    patches: Record<string, unknown>[];
  } = {
    config: {
      agentProfiles: initialProfiles,
      appendSystemPrompt: "keep this daemon setting",
      pluginsEnabled: true,
    },
    patches: [],
  };
  const adapter = {
    config: {
      get: async () => ({ config: state.config }),
      patch: async (patch: unknown) => {
        const update = patch as Record<string, unknown>;
        state.patches.push(update);
        state.config = { ...state.config, ...update };
        return { config: state.config };
      },
    },
  } as unknown as PaseoAdapter;
  return { adapter, state };
}

async function createService(options: { profiles?: Profile[]; fault?: Fault } = {}) {
  const home = await mkdtemp(path.join(tmpdir(), "paseo-profiles-service-"));
  homes.push(home);
  await writeFile(path.join(home, "server-id"), "paseo-profiles-unit-test\n", { flag: "wx" });
  const paseo = createPaseo(options.profiles);
  const service = new ProfileService({ home, paseo: paseo.adapter, fault: options.fault });
  return { home, paseo, service };
}

function first<T>(items: T[]): T {
  const item = items[0];
  if (item === undefined) throw new Error("Expected at least one item");
  return item;
}

function previewInput(set: ProfileSet) {
  return {
    libraryRoot: "",
    files: [{ name: `${set.name}.yaml`, text: serializeSet(set) }],
    asCopy: false,
  };
}

describe("profile service import and activation", () => {
  it("advances Jamie's baseline without a head write, then requires consent to replace local edits", async () => {
    const faultStages: string[] = [];
    const { service } = await createService({
      fault: (stage) => {
        faultStages.push(stage);
      },
    });
    const jamieV1 = profileSet({
      id: "jamie-import",
      profiles: [profile({ id: "review", name: "Review", notes: "Jamie v1" })],
    });
    const firstPreview = await service.importPreview(previewInput(jamieV1));
    const firstCommit = await service.importCommit({
      libraryRoot: "",
      previewId: firstPreview.previewId,
      replaceLocalChanges: false,
    });
    const imported = first(firstCommit.entries);

    const jamieV2 = profileSet({
      id: jamieV1.id,
      profiles: [profile({ id: "review", name: "Review", notes: "Jamie v2" })],
    });
    const matchingHead = await service.saveSet({
      libraryRoot: "",
      localId: imported.localId,
      expectedRevision: imported.revision,
      set: jamieV2,
    });
    faultStages.length = 0;
    const metadataPreview = await service.importPreview(previewInput(jamieV2));
    const metadataItem = first(metadataPreview.items);

    expect(metadataItem.localChanges).toBe(true);
    expect(metadataItem.diff).toEqual({ added: [], changed: [], removed: [], reordered: false });
    expect(metadataItem.message.toLowerCase()).toMatch(/metadata|baseline|source/);
    expect(metadataItem.message.toLowerCase()).not.toMatch(/replace|overwrite/);

    const metadataCommit = await service.importCommit({
      libraryRoot: "",
      previewId: metadataPreview.previewId,
      replaceLocalChanges: false,
    });
    const metadataHead = first(metadataCommit.entries);
    expect(metadataHead).toEqual(matchingHead);
    expect(faultStages.filter((stage) => stage === "beforeHeadWrite")).toHaveLength(0);

    const confirmedBaseline = await service.importPreview(previewInput(jamieV2));
    expect(first(confirmedBaseline.items).sourceUnchanged).toBe(true);

    const localEdit = profileSet({
      id: jamieV1.id,
      profiles: [profile({ id: "review", name: "Review", notes: "local edit" })],
    });
    await service.saveSet({
      libraryRoot: "",
      localId: metadataHead.localId,
      expectedRevision: metadataHead.revision,
      set: localEdit,
    });
    const jamieV3 = profileSet({
      id: jamieV1.id,
      profiles: [profile({ id: "review", name: "Review", notes: "Jamie v3" })],
    });
    const replacementPreview = await service.importPreview(previewInput(jamieV3));
    expect(first(replacementPreview.items).localChanges).toBe(true);

    await expect(
      service.importCommit({
        libraryRoot: "",
        previewId: replacementPreview.previewId,
        replaceLocalChanges: false,
      }),
    ).rejects.toThrow(/Replace local changes/);
    const replacement = await service.importCommit({
      libraryRoot: "",
      previewId: replacementPreview.previewId,
      replaceLocalChanges: true,
    });
    expect(first(replacement.entries).set).toEqual(jamieV3);
  });

  it("reconciles a failed metadata write through the cached store before the next import preview", async () => {
    let failNextMetadataWrite = false;
    const { service } = await createService({
      fault: (stage) => {
        if (stage === "beforeMetadataWrite" && failNextMetadataWrite) {
          failNextMetadataWrite = false;
          throw new Error("metadata write interrupted");
        }
      },
    });
    const jamieV1 = profileSet({
      id: "jamie-cached-recovery",
      profiles: [profile({ id: "review", name: "Review", notes: "Jamie v1" })],
    });
    const firstPreview = await service.importPreview(previewInput(jamieV1));
    const firstCommit = await service.importCommit({
      libraryRoot: "",
      previewId: firstPreview.previewId,
      replaceLocalChanges: false,
    });
    const imported = first(firstCommit.entries);

    const jamieV2 = profileSet({
      id: jamieV1.id,
      profiles: [profile({ id: "review", name: "Review", notes: "Jamie v2" })],
    });
    const editedHead = await service.saveSet({
      libraryRoot: "",
      localId: imported.localId,
      expectedRevision: imported.revision,
      set: jamieV2,
    });
    const cachedStore = await service.store();
    failNextMetadataWrite = true;
    const updatePreview = await service.importPreview(previewInput(jamieV2));
    const failedUpdate = await service.importCommit({
      libraryRoot: "",
      previewId: updatePreview.previewId,
      replaceLocalChanges: false,
    });

    expect(failedUpdate.libraryError).toMatch(/metadata write interrupted/);
    expect(failedUpdate.applied).toBe(false);
    expect(failedUpdate.entries).toEqual([]);
    expect(await service.readSet({ libraryRoot: "", localId: editedHead.localId })).toEqual(
      editedHead,
    );

    expect(await service.store()).toBe(cachedStore);
    const reconciledPreview = await service.importPreview(previewInput(jamieV2));
    expect(first(reconciledPreview.items).sourceUnchanged).toBe(true);
    expect(first(reconciledPreview.items).localChanges).toBe(false);
  });

  it("reports a recoverable partial batch and does not apply after a later file write fails", async () => {
    let headWrites = 0;
    const { service } = await createService({
      fault: (stage) => {
        if (stage === "beforeHeadWrite") {
          headWrites += 1;
          if (headWrites === 2) throw new Error("second set could not be published");
        }
      },
    });
    const original = profileSet({ id: "batch-one" });
    const newer = profileSet({ id: "batch-two", name: "Batch two" });
    const preview = await service.importPreview({
      libraryRoot: "",
      files: [
        { name: "first.yaml", text: serializeSet(original) },
        { name: "second.yaml", text: serializeSet(newer) },
      ],
      asCopy: false,
    });

    const result = await service.importCommit({
      libraryRoot: "",
      previewId: preview.previewId,
      replaceLocalChanges: false,
    });

    expect(result.libraryUpdated).toBe(true);
    expect(result.libraryError).toMatch(/inspect recovery/);
    expect(result.entries).toHaveLength(1);
    expect(result.applied).toBe(false);
    expect(
      (await service.listLibrary({ libraryRoot: "" })).entries.map((entry) => entry.set.id),
    ).toEqual([original.id]);
  });

  it("requires an explicit target when several saved sets share the portable ID", async () => {
    const { service } = await createService();
    const firstSet = await service.saveSet({
      libraryRoot: "",
      set: profileSet({ id: "shared-jamie-id" }),
    });
    await service.saveSet({
      libraryRoot: "",
      set: profileSet({ id: "shared-jamie-id", name: "Local copy" }),
    });
    const incoming = profileSet({ id: "shared-jamie-id", name: "Jamie update" });
    const ambiguous = await service.importPreview(previewInput(incoming));

    expect(first(ambiguous.items).candidates).toHaveLength(2);
    await expect(
      service.importCommit({
        libraryRoot: "",
        previewId: ambiguous.previewId,
        replaceLocalChanges: false,
      }),
    ).rejects.toThrow(/Several saved packs match/);

    const selected = await service.importPreview({
      ...previewInput(incoming),
      targetLocalId: firstSet.localId,
    });
    const committed = await service.importCommit({
      libraryRoot: "",
      previewId: selected.previewId,
      replaceLocalChanges: false,
    });
    expect(first(committed.entries).localId).toBe(firstSet.localId);
  });

  it("snapshots before patch, preserves unrelated config, and records an ambiguous post-patch result", async () => {
    let snapshotsPresentAtPatch = false;
    let storeStatePath = "";
    const { paseo, service } = await createService({
      profiles: [
        profile({ id: "existing", name: "Existing" }),
        profile({ id: "untouched", name: "Untouched" }),
      ],
      fault: async (stage) => {
        if (stage === "beforeConfigPatch") {
          snapshotsPresentAtPatch =
            (await readdir(path.join(storeStatePath, "snapshots"))).length > 0;
        }
        if (stage === "afterConfigPatch") throw new Error("simulated lost response after patch");
      },
    });
    const store = await service.store();
    storeStatePath = store.state;
    const source = profileSet({
      id: "add-collisions",
      profiles: [
        profile({ id: "existing", name: "Imported existing" }),
        profile({ id: "new", name: "New profile" }),
      ],
    });
    const entry = await service.saveSet({ libraryRoot: "", set: source });
    const preview = await service.applyPreview({
      libraryRoot: "",
      localId: entry.localId,
      mode: "add",
      selections: [
        { profileId: "existing", action: "keep-both" },
        { profileId: "new", action: "add" },
      ],
    });

    await expect(
      service.applyCommit({ libraryRoot: "", previewId: preview.previewId }),
    ).rejects.toThrow(/inspect recovery/);

    expect(snapshotsPresentAtPatch).toBe(true);
    expect(paseo.state.patches).toHaveLength(1);
    expect(paseo.state.patches[0]).toEqual({ agentProfiles: preview.target });
    expect(paseo.state.config.appendSystemPrompt).toBe("keep this daemon setting");
    expect(paseo.state.config.agentProfiles).toEqual(preview.target);

    const recovery = await service.recoveryList({ libraryRoot: "" });
    expect(recovery.snapshots).toHaveLength(1);
    expect(recovery.operations).toMatchObject([{ status: "complete" }]);
  });

  it("rejects an apply review after live profiles change and keeps the newer list", async () => {
    const original = profile({ id: "current", name: "Current" });
    const { paseo, service } = await createService({ profiles: [original] });
    const source = profileSet({
      id: "apply-source",
      profiles: [profile({ id: "target", name: "Target" })],
    });
    const entry = await service.saveSet({ libraryRoot: "", set: source });
    const preview = await service.applyPreview({
      libraryRoot: "",
      localId: entry.localId,
      mode: "use",
    });
    const latest = [original, profile({ id: "added-elsewhere", name: "Added elsewhere" })];
    paseo.state.config = { ...paseo.state.config, agentProfiles: latest };

    await expect(
      service.applyCommit({ libraryRoot: "", previewId: preview.previewId }),
    ).rejects.toThrow(/Current agent profiles changed/);
    expect(paseo.state.config.agentProfiles).toEqual(latest);
    expect(paseo.state.patches).toHaveLength(0);
  });
});
