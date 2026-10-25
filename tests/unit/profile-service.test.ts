import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Fault } from "../../server/files";
import { type PaseoAdapter, ProfileService } from "../../server/profile-service";
import { parseSet, serializeSet } from "../../server/yaml";
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

async function createService(
  options: { profiles?: Profile[]; fault?: Fault; providers?: PaseoAdapter["providers"] } = {},
) {
  const home = await mkdtemp(path.join(tmpdir(), "paseo-profiles-service-"));
  homes.push(home);
  await writeFile(path.join(home, "server-id"), "paseo-profiles-unit-test\n", { flag: "wx" });
  const paseo = createPaseo(options.profiles);
  paseo.adapter.providers = options.providers;
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
  it("captures and exports appearance and shared prompt, and detects stale prompt edits", async () => {
    const selected = profile({ id: "selected", name: "Selected", icon: "bug", color: "violet" });
    const { service, paseo } = await createService({
      profiles: [selected, profile({ id: "other", name: "Other" })],
    });
    paseo.state.config.appendSystemPrompt = "Shared instructions\nKeep exact spacing.\n";
    const current = await service.currentProfiles();
    const capture = {
      libraryRoot: "",
      name: "Portable team",
      profileIds: [selected.id],
      expectedCurrentRevision: current.revision,
    };
    const saved = await service.captureCurrent(capture);
    expect(saved.set.profiles).toEqual([selected]);
    expect(saved.set.appendSystemPrompt).toBe(current.appendSystemPrompt);
    expect(paseo.state.patches).toEqual([]);
    const exported = await service.exportProfiles({ source: "current", ...capture });
    expect(parseSet(first(exported.files).text).set).toMatchObject({
      profiles: [selected],
      appendSystemPrompt: current.appendSystemPrompt,
    });
    const libraryExport = await service.exportProfiles({
      libraryRoot: "",
      source: "library",
      localIds: [saved.localId],
    });
    expect(parseSet(first(libraryExport.files).text).set).toEqual(saved.set);

    paseo.state.config.appendSystemPrompt = "Changed after selection";
    await expect(service.captureCurrent(capture)).rejects.toThrow(/Current profiles changed/);
    await expect(service.exportProfiles({ source: "current", ...capture })).rejects.toThrow(
      /Current profiles changed/,
    );
  });

  it.each([
    { mode: "use" as const, prompt: "Incoming shared prompt" },
    { mode: "add" as const, prompt: "" },
  ])("reviews, applies, and recovers shared prompt in $mode mode", async ({ mode, prompt }) => {
    const existing = profile({ id: "existing", name: "Existing" });
    const incoming = profile({ id: "incoming", name: "Incoming" });
    const { service, paseo } = await createService({ profiles: [existing] });
    const saved = await service.saveSet({
      libraryRoot: "",
      set: profileSet({ profiles: [incoming], appendSystemPrompt: prompt }),
    });
    const review = await service.applyPreview({
      libraryRoot: "",
      localId: saved.localId,
      mode,
      applySystemPrompt: true,
      selections: [{ profileId: incoming.id, action: "add" }],
    });
    expect(review.systemPrompt).toEqual({ before: "keep this daemon setting", target: prompt });
    expect(paseo.state.patches).toEqual([]);
    await service.applyCommit({ libraryRoot: "", previewId: review.previewId });
    expect(paseo.state.config.appendSystemPrompt).toBe(prompt);
    expect(paseo.state.config.agentProfiles).toEqual(
      mode === "add" ? [existing, incoming] : [incoming],
    );
    expect(paseo.state.config.pluginsEnabled).toBe(true);
    const recovery = await service.recoveryList({ libraryRoot: "" });
    const restore = await service.applyPreview({
      libraryRoot: "",
      snapshotId: first(recovery.snapshots).id,
      mode: "restore",
    });
    expect(restore.target).toEqual([existing]);
    expect(restore.systemPrompt).toEqual({ before: prompt, target: "keep this daemon setting" });
    await service.applyCommit({ libraryRoot: "", previewId: restore.previewId });
    expect(paseo.state.config.appendSystemPrompt).toBe("keep this daemon setting");
  });

  it("preserves the host prompt by default when adding profiles from a pack with a prompt", async () => {
    const { service, paseo } = await createService();
    const entry = await service.saveSet({
      libraryRoot: "",
      set: profileSet({ appendSystemPrompt: "Incoming prompt" }),
    });
    const review = await service.applyPreview({
      libraryRoot: "",
      localId: entry.localId,
      mode: "add",
      selections: entry.set.profiles.map((item) => ({ profileId: item.id, action: "add" })),
    });
    expect(review.systemPrompt).toBeUndefined();
    await service.applyCommit({ libraryRoot: "", previewId: review.previewId });
    expect(paseo.state.config.appendSystemPrompt).toBe("keep this daemon setting");
    expect(paseo.state.patches[0]).not.toHaveProperty("appendSystemPrompt");
  });

  it("rejects a shared prompt apply after another client edits only the prompt", async () => {
    const { service, paseo } = await createService();
    const entry = await service.saveSet({
      libraryRoot: "",
      set: profileSet({ appendSystemPrompt: "Incoming" }),
    });
    const review = await service.applyPreview({
      libraryRoot: "",
      localId: entry.localId,
      mode: "use",
    });
    paseo.state.config.appendSystemPrompt = "Someone else's latest edit";
    await expect(
      service.applyCommit({ libraryRoot: "", previewId: review.previewId }),
    ).rejects.toThrow(/Shared system prompt changed/);
    expect(paseo.state.patches).toEqual([]);
  });

  it("includes prompt state when reconciling an uncertain prompt-only apply", async () => {
    const existing = profile({ id: "same", name: "Same" });
    const { service, paseo } = await createService({
      profiles: [existing],
      fault: (stage) => {
        if (stage === "afterConfigPatch") throw new Error("lost response");
      },
    });
    const entry = await service.saveSet({
      libraryRoot: "",
      set: profileSet({ profiles: [existing], appendSystemPrompt: "Incoming" }),
    });
    const review = await service.applyPreview({
      libraryRoot: "",
      localId: entry.localId,
      mode: "use",
    });
    await expect(
      service.applyCommit({ libraryRoot: "", previewId: review.previewId }),
    ).rejects.toThrow(/inspect recovery/);
    const store = await service.store();
    const snapshot = JSON.parse(
      await readFile(
        path.join(
          store.state,
          "snapshots",
          first(await readdir(path.join(store.state, "snapshots"))),
        ),
        "utf8",
      ),
    );
    expect(snapshot.appendSystemPrompt).toBe("keep this daemon setting");
    paseo.state.config.appendSystemPrompt = "A third prompt";
    expect((await service.recoveryList({ libraryRoot: "" })).operations).toMatchObject([
      { status: "ambiguous" },
    ]);
  });

  it("keeps incoming settings portable while resolving only selected profiles on apply", async () => {
    const existing = profile({
      id: "existing",
      name: "Existing",
      provider: "offline",
      model: "keep-old",
    });
    const { service, paseo } = await createService({
      profiles: [existing],
      providers: {
        snapshot: async () => ({
          requestId: "unit-provider-snapshot",
          generatedAt: new Date().toISOString(),
          entries: [
            {
              provider: "local",
              enabled: true,
              status: "ready",
              models: [{ provider: "local", id: "local-default", label: "Local", isDefault: true }],
            },
          ],
        }),
      },
    });
    const source = profileSet({
      profiles: [
        profile({
          id: "automatic",
          name: "Automatic",
          provider: "",
          icon: "future-icon",
          color: "future-color",
        }),
        profile({ id: "skipped", name: "Skipped", provider: "missing" }),
      ],
    });
    const imported = await service.importPreview(previewInput(source));
    const saved = first(
      (
        await service.importCommit({
          libraryRoot: "",
          previewId: imported.previewId,
          replaceLocalChanges: false,
        })
      ).entries,
    );
    const review = await service.applyPreview({
      libraryRoot: "",
      localId: saved.localId,
      mode: "add",
      selections: [
        { profileId: "automatic", action: "add" },
        { profileId: "skipped", action: "skip" },
      ],
    });
    expect(review.target).toEqual([
      existing,
      { ...source.profiles[0], provider: "local", model: "local-default" },
    ]);
    expect(review.warnings.join("\n")).not.toContain("Skipped");
    await service.applyCommit({ libraryRoot: "", previewId: review.previewId });
    expect(paseo.state.config.agentProfiles).toEqual(review.target);
    expect((await service.readSet({ libraryRoot: "", localId: saved.localId })).set).toEqual(
      source,
    );
  });

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
