import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serializeSet } from "../../server/yaml";
import {
  applyCommit,
  applyPreview,
  currentProfiles,
  duplicateSet,
  historyList,
  importCommit,
  importPreview,
  listLibrary,
  readSet,
  recoveryList,
  saveSet,
} from "../../shared/rpc";
import { profile, profileSet } from "../fixtures/profile-sets";
import { type IsolatedDaemon, startIsolatedDaemon } from "./support/isolated-daemon";
import { callPluginRpc } from "./support/plugin-rpc";

describe("Paseo plugin RPC on an isolated real daemon", () => {
  let daemon: IsolatedDaemon | undefined;

  beforeAll(async () => {
    daemon = await startIsolatedDaemon();
  }, 60_000);

  afterAll(async () => {
    await daemon?.close();
  }, 30_000);

  it("saves, reopens, duplicates, and rejects a stale library revision", async () => {
    if (!daemon) throw new Error("The isolated daemon did not start");
    const initial = profileSet({ id: "rpc-library-set" });
    const saved = await callPluginRpc(daemon, saveSet, { libraryRoot: "", set: initial });
    expect(
      await callPluginRpc(daemon, readSet, { libraryRoot: "", localId: saved.localId }),
    ).toEqual(saved);

    const updated = { ...saved.set, name: "RPC updated set" };
    const next = await callPluginRpc(daemon, saveSet, {
      libraryRoot: "",
      localId: saved.localId,
      expectedRevision: saved.revision,
      set: updated,
    });
    expect(next.set.name).toBe("RPC updated set");
    await expect(
      callPluginRpc(daemon, saveSet, {
        libraryRoot: "",
        localId: saved.localId,
        expectedRevision: saved.revision,
        set: initial,
      }),
    ).rejects.toThrow(/changed since the preview/i);

    const copy = await callPluginRpc(daemon, duplicateSet, {
      libraryRoot: "",
      localId: next.localId,
      expectedRevision: next.revision,
      name: "RPC copy",
    });
    expect(copy.set.id).not.toBe(next.set.id);
    expect(copy.set.copiedFrom).toBe(next.set.id);
    expect((await callPluginRpc(daemon, listLibrary, { libraryRoot: "" })).entries).toHaveLength(2);
    expect(
      (await callPluginRpc(daemon, historyList, { libraryRoot: "", localId: next.localId }))
        .versions,
    ).toContainEqual(expect.objectContaining({ name: initial.name }));
  });

  it("keeps import library-only until Add selected profiles is committed", async () => {
    if (!daemon) throw new Error("The isolated daemon did not start");
    const unrelated = profile({ id: "rpc-unrelated", name: "Keep this profile" });
    await daemon.client.patchDaemonConfig({
      agentProfiles: [unrelated],
      appendSystemPrompt: "Keep this unrelated daemon setting",
    });
    const before = await callPluginRpc(daemon, currentProfiles, {});
    const set = profileSet({
      id: "rpc-import-set",
      profiles: [profile({ id: "rpc-imported", name: "Imported profile" })],
    });
    const preview = await callPluginRpc(daemon, importPreview, {
      libraryRoot: "",
      files: [{ name: "imported.yaml", text: serializeSet(set) }],
      asCopy: false,
    });
    const imported = await callPluginRpc(daemon, importCommit, {
      libraryRoot: "",
      previewId: preview.previewId,
      replaceLocalChanges: false,
    });
    const importedEntry = imported.entries[0];
    if (!importedEntry) throw new Error("Import did not return a saved set");

    expect(imported.libraryUpdated).toBe(true);
    expect(imported.applied).toBe(false);
    expect(imported.entries).toHaveLength(1);
    expect((await callPluginRpc(daemon, currentProfiles, {})).profiles).toEqual(before.profiles);

    const recoveryBefore = await callPluginRpc(daemon, recoveryList, { libraryRoot: "" });
    const addReview = await callPluginRpc(daemon, applyPreview, {
      libraryRoot: "",
      localId: importedEntry.localId,
      mode: "add",
      selections: [{ profileId: "rpc-imported", action: "add" }],
    });
    const applied = await callPluginRpc(daemon, applyCommit, {
      libraryRoot: "",
      previewId: addReview.previewId,
    });
    const after = await daemon.client.getDaemonConfig();

    expect(applied.profiles).toEqual([unrelated, ...set.profiles]);
    expect(after.config.agentProfiles).toEqual([unrelated, ...set.profiles]);
    expect(after.config.appendSystemPrompt).toBe("Keep this unrelated daemon setting");
    expect((await callPluginRpc(daemon, recoveryList, { libraryRoot: "" })).snapshots).toHaveLength(
      recoveryBefore.snapshots.length + 1,
    );
  });

  it("refuses a stale apply preview after the live profile list changes", async () => {
    if (!daemon) throw new Error("The isolated daemon did not start");
    const source = profileSet({
      id: "rpc-stale-apply",
      profiles: [profile({ id: "rpc-stale-target", name: "Target from saved set" })],
    });
    const saved = await callPluginRpc(daemon, saveSet, { libraryRoot: "", set: source });
    const review = await callPluginRpc(daemon, applyPreview, {
      libraryRoot: "",
      localId: saved.localId,
      mode: "use",
    });
    const latest = [
      ...(await callPluginRpc(daemon, currentProfiles, {})).profiles,
      profile({ id: "rpc-concurrent", name: "Concurrent update" }),
    ];
    await daemon.client.patchDaemonConfig({ agentProfiles: latest });

    await expect(
      callPluginRpc(daemon, applyCommit, { libraryRoot: "", previewId: review.previewId }),
    ).rejects.toThrow(/Current agent profiles changed/);
    expect((await callPluginRpc(daemon, currentProfiles, {})).profiles).toEqual(latest);
  });
});
