import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import type { RpcInput } from "@getpaseo/plugin";
import { canonicalJson, profilesDiff } from "../shared/canonical";
import { describeImport } from "../shared/import-plan";
import type * as contracts from "../shared/rpc";
import {
  type LibraryEntry,
  type Profile,
  type ProfileSet,
  ProfilesSchema,
  SetSchema,
} from "../shared/set";
import {
  defaultHome,
  errorText,
  expandPath,
  type Fault,
  hash,
  readJson,
  withDirectoryLock,
  writeJson,
} from "./files";
import { type ImportMetadata, LibraryStore } from "./library-store";
import { parseSet, serializeSet } from "./yaml";

export interface PaseoAdapter {
  config: Pick<PaseoApi["config"], "get" | "patch">;
  providers?: Pick<PaseoApi["providers"], "snapshot">;
}
type ImportItem = ReturnType<typeof describeImport> & {
  index: number;
  fileName: string;
  incoming: ProfileSet;
  target?: LibraryEntry;
  candidates: { localId: string; name: string; reason: string }[];
  ambiguous: boolean;
  metadata?: ImportMetadata;
};
interface ImportPlan {
  id: string;
  root: string;
  expires: number;
  inventory: string;
  items: ImportItem[];
  committed?: boolean;
}
interface ApplyPlan {
  id: string;
  root: string;
  expires: number;
  before: Profile[];
  target: Profile[];
  beforeHash: string;
  sourceName: string;
  localId?: string;
  revision?: string;
  importPreviewId?: string;
  snapshotId?: string;
  committed?: boolean;
  operationId?: string;
}
interface Operation {
  id: string;
  createdAt: string;
  status: string;
  sourceName: string;
  libraryRoot: string;
  sourceRevision?: string;
  target: Profile[];
  beforeHash: string;
  targetHash: string;
  error?: string;
}
interface Snapshot {
  id: string;
  createdAt: string;
  profiles: Profile[];
}
export class ProfileService {
  readonly home: string;
  private readonly getDirectory: () => string | Promise<string>;
  private readonly paseo: PaseoAdapter;
  private readonly fault: Fault;
  private readonly stores = new Map<string, LibraryStore>();
  private readonly imports = new Map<string, ImportPlan>();
  private readonly applies = new Map<string, ApplyPlan>();
  private activationQueue: Promise<unknown> = Promise.resolve();
  constructor(options: {
    home?: string;
    getDirectory?: () => string | Promise<string>;
    paseo: PaseoAdapter;
    fault?: Fault;
  }) {
    this.home = expandPath(options.home ?? defaultHome());
    this.getDirectory = options.getDirectory ?? (() => "");
    this.paseo = options.paseo;
    this.fault = options.fault ?? (() => {});
  }
  async store(requestedRoot = "", reconcile = true): Promise<LibraryStore> {
    const configured = (await this.getDirectory()).trim();
    const store = new LibraryStore({ home: this.home, root: configured, fault: this.fault });
    await store.initialize();
    if (requestedRoot && (await fs.realpath(expandPath(requestedRoot))) !== store.root)
      throw new Error("Library folder changed. Refresh and review again.");
    const existing = this.stores.get(store.root);
    if (existing) {
      if (reconcile) await existing.recoverLibrary();
      return existing;
    }
    if (reconcile) await store.recoverLibrary();
    this.stores.set(store.root, store);
    return store;
  }
  private remember<T extends { id: string; expires: number }>(map: Map<string, T>, plan: T) {
    for (const [id, existing] of map) if (existing.expires < Date.now()) map.delete(id);
    if (map.size >= 100)
      throw new Error("Too many pending reviews. Close old reviews and try again.");
    map.set(plan.id, plan);
    return plan;
  }
  private plan<T extends { root: string; expires: number }>(
    map: Map<string, T>,
    id: string,
    store: LibraryStore,
  ): T {
    const plan = map.get(id);
    if (!plan || plan.expires < Date.now())
      throw new Error("Review expired or plugin restarted. Create a fresh preview.");
    if (plan.root !== store.root) throw new Error("Library folder changed. Review again.");
    return plan;
  }
  async listLibrary(input: RpcInput<typeof contracts.listLibrary>) {
    return (await this.store(input.libraryRoot)).list();
  }
  async readSet(input: RpcInput<typeof contracts.readSet>) {
    return (await this.store(input.libraryRoot)).read(input.localId);
  }
  async saveSet(input: RpcInput<typeof contracts.saveSet>) {
    return (await this.store(input.libraryRoot)).save(
      input.set,
      input.localId,
      input.expectedRevision,
    );
  }
  async duplicateSet(input: RpcInput<typeof contracts.duplicateSet>) {
    const store = await this.store(input.libraryRoot);
    return store.locked(async () => {
      const source = await store.assertRevision(input.localId, input.expectedRevision);
      return store.saveUnlocked({
        ...source.set,
        id: randomUUID(),
        copiedFrom: source.set.id,
        name: input.name,
      });
    });
  }
  async deleteSet(input: RpcInput<typeof contracts.deleteSet>) {
    return (await this.store(input.libraryRoot)).remove(input.localId, input.expectedRevision);
  }
  async origin() {
    const serverId = (await fs.readFile(path.join(this.home, "server-id"), "utf8")).trim();
    if (!serverId)
      throw new Error("Daemon server-id is empty; cannot calculate a persistent source origin");
    const sourcePath = await fs.realpath(path.join(this.home, "config.json")).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return path.join(this.home, "config.json");
      throw error;
    });
    return { fingerprint: hash(["paseo-profile-origin", 1, serverId, sourcePath]) };
  }
  private async live() {
    return ProfilesSchema.parse((await this.paseo.config.get()).config.agentProfiles ?? []);
  }
  async warnings(profiles: Profile[]): Promise<string[]> {
    if (!this.paseo.providers)
      return ["Provider availability could not be checked; saved values are preserved."];
    try {
      const { entries } = await this.paseo.providers.snapshot();
      const warnings: string[] = [];
      for (const profile of profiles) {
        const provider = entries.find((p) => p.provider === profile.provider);
        if (!provider?.enabled || provider.status !== "ready")
          warnings.push(
            `${profile.name}: provider ${profile.provider} is unavailable or still loading.`,
          );
        else if (
          profile.model &&
          provider.models &&
          !provider.models.some((model) => model.id === profile.model)
        )
          warnings.push(
            `${profile.name}: model ${profile.model} is not in the current provider catalog.`,
          );
      }
      return warnings;
    } catch (error) {
      return [
        `Provider availability could not be checked: ${errorText(error)}. Values are preserved.`,
      ];
    }
  }
  async currentProfiles(_input: RpcInput<typeof contracts.currentProfiles> = {}) {
    const profiles = await this.live();
    return {
      profiles,
      revision: hash(profiles),
      origin: await this.origin(),
      warnings: await this.warnings(profiles),
    };
  }
  private select(profiles: Profile[], ids?: string[]) {
    if (!ids) return profiles;
    const chosen = new Set(ids);
    if (chosen.size !== ids.length) throw new Error("Duplicate profile selection");
    if (ids.some((id) => !profiles.some((p) => p.id === id)))
      throw new Error("Selected profile no longer exists");
    return profiles.filter((p) => chosen.has(p.id));
  }
  async captureCurrent(input: RpcInput<typeof contracts.captureCurrent>) {
    const profiles = await this.live();
    if (hash(profiles) !== input.expectedCurrentRevision)
      throw new Error("Current profiles changed. Refresh and review again.");
    const store = await this.store(input.libraryRoot);
    const selected = this.select(profiles, input.profileIds);
    return store.locked(async () => {
      const previous = input.localId
        ? await store.assertRevision(input.localId, input.expectedRevision)
        : undefined;
      const set = SetSchema.parse({
        format: "paseo-profile-set",
        version: 1,
        id: previous?.set.id ?? randomUUID(),
        name: input.name,
        origin: previous?.set.origin ?? (await this.origin()),
        ...(previous?.set.copiedFrom ? { copiedFrom: previous.set.copiedFrom } : {}),
        profiles: selected,
      });
      return store.saveUnlocked(set, input.localId, input.expectedRevision);
    });
  }
  async exportProfiles(input: RpcInput<typeof contracts.exportProfiles>) {
    const sets: ProfileSet[] = [];
    if (input.source === "current") {
      const profiles = await this.live();
      if (input.expectedCurrentRevision && hash(profiles) !== input.expectedCurrentRevision)
        throw new Error("Current profiles changed. Review the selection again.");
      sets.push(
        SetSchema.parse({
          format: "paseo-profile-set",
          version: 1,
          id: randomUUID(),
          name: input.name ?? "Current agent profiles",
          origin: await this.origin(),
          profiles: this.select(profiles, input.profileIds),
        }),
      );
    } else {
      if (!input.localIds?.length) throw new Error("Select at least one saved pack");
      const store = await this.store(input.libraryRoot);
      for (const id of input.localIds) {
        const { set } = await store.read(id);
        const profiles = this.select(set.profiles, input.profileIds);
        const subset = profiles.length !== set.profiles.length;
        sets.push(
          SetSchema.parse({
            ...set,
            ...(subset ? { id: randomUUID(), copiedFrom: set.id } : {}),
            profiles,
          }),
        );
      }
    }
    return {
      files: sets.map((set, index) => ({
        name: `${set.name.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 70) || "profiles"}-${index + 1}.yaml`,
        text: serializeSet(set),
      })),
    };
  }
  async importPreview(input: RpcInput<typeof contracts.importPreview>) {
    if (input.targetLocalId && input.files.length !== 1)
      throw new Error("Choose an existing target for one input file at a time");
    const store = await this.store(input.libraryRoot);
    const listed = await store.list();
    const items: ImportItem[] = [];
    for (const [index, file] of input.files.entries()) {
      const parsed = parseSet(
        file.text,
        file.name.replace(/\.(json|ya?ml)$/i, "") || "Imported profiles",
      );
      let incoming = parsed.set;
      const matches = parsed.hasIdentity
        ? listed.entries.filter((e) => e.set.id === incoming.id)
        : [];
      const target = input.asCopy
        ? undefined
        : input.targetLocalId
          ? await store.read(input.targetLocalId)
          : matches.length === 1
            ? matches[0]
            : undefined;
      const ambiguous = !input.asCopy && !input.targetLocalId && matches.length > 1;
      const candidates = listed.entries
        .filter(
          (e) =>
            matches.includes(e) ||
            (incoming.origin && e.set.origin?.fingerprint === incoming.origin.fingerprint),
        )
        .map((e) => ({
          localId: e.localId,
          name: e.set.name,
          reason: matches.includes(e) ? "Matching source pack ID" : "Related source origin",
        }));
      if (input.asCopy)
        incoming = {
          ...incoming,
          id: randomUUID(),
          copiedFrom: incoming.id === "legacy" ? undefined : incoming.id,
        };
      else if (!parsed.hasIdentity) incoming = { ...incoming, id: target?.set.id ?? randomUUID() };
      const metadata = await (target ? store.metadata(target.localId) : Promise.resolve(undefined));
      const description = describeImport(target?.set, incoming, metadata?.baseline);
      items.push({
        index,
        fileName: file.name,
        incoming,
        target,
        candidates,
        ambiguous,
        ...description,
        metadata: {
          sourceSetId: incoming.id,
          originFingerprint: incoming.origin?.fingerprint,
          baseline: incoming,
          baselineHash: hash(incoming),
        },
      });
    }
    const ids = items.map((i) => i.target?.localId ?? i.incoming.id);
    if (new Set(ids).size !== ids.length)
      throw new Error("Several files target the same pack; import them separately");
    const plan = this.remember(this.imports, {
      id: randomUUID(),
      root: store.root,
      expires: Date.now() + 15 * 60_000,
      inventory: await store.inventoryHash(),
      items,
    });
    return {
      previewId: plan.id,
      items: items.map(({ ambiguous: _ambiguous, metadata: _metadata, ...item }) => item),
    };
  }
  private async checkImport(store: LibraryStore, plan: ImportPlan, replaceLocalChanges: boolean) {
    await this.store(plan.root, false);
    if (plan.committed) throw new Error("This import was already committed. Refresh the library.");
    if ((await store.inventoryHash()) !== plan.inventory)
      throw new Error("Library changed since the preview. Review again.");
    for (const item of plan.items) {
      if (item.ambiguous)
        throw new Error(
          "Several saved packs match this source. Choose an explicit target and review again.",
        );
      if (item.target) await store.assertRevision(item.target.localId, item.target.revision);
      if (
        item.localChanges &&
        !item.sourceUnchanged &&
        canonicalJson(item.incoming) !== canonicalJson(item.target?.set) &&
        !replaceLocalChanges
      )
        throw new Error("Explicitly choose Replace local changes before overwriting local edits");
    }
  }
  async importCommit(input: RpcInput<typeof contracts.importCommit>) {
    const store = await this.store(input.libraryRoot);
    const plan = this.plan(this.imports, input.previewId, store);
    const apply = input.applyPreviewId
      ? this.plan(this.applies, input.applyPreviewId, store)
      : undefined;
    if (apply && apply.importPreviewId !== plan.id)
      throw new Error("Apply review belongs to another import");
    const perform = async () =>
      store.locked(async () => {
        await this.checkImport(store, plan, input.replaceLocalChanges);
        if (apply) await this.checkApply(store, apply, true);
        const entries: LibraryEntry[] = [];
        let libraryUpdated = false;
        plan.committed = true;
        try {
          for (const item of plan.items) {
            if (item.target && item.sourceUnchanged)
              entries.push(await store.read(item.target.localId));
            else if (
              item.target &&
              canonicalJson(item.target.set) === canonicalJson(item.incoming)
            ) {
              if (
                canonicalJson(await store.metadata(item.target.localId)) !==
                canonicalJson(item.metadata)
              ) {
                await store.setMetadataUnlocked(
                  item.target.localId,
                  item.metadata as ImportMetadata,
                );
                libraryUpdated = true;
              }
              entries.push(await store.read(item.target.localId));
            } else {
              entries.push(
                await store.saveUnlocked(
                  item.incoming,
                  item.target?.localId,
                  item.target?.revision,
                  item.metadata,
                ),
              );
              libraryUpdated = true;
            }
          }
        } catch (error) {
          return {
            entries,
            libraryUpdated: true,
            applied: false,
            libraryError: `Import interrupted; inspect recovery before retrying: ${errorText(error)}`,
          };
        }
        if (!apply) return { entries, libraryUpdated, applied: false };
        try {
          const result = await this.applyUnlocked(store, apply);
          return { entries, libraryUpdated, applied: true, operationId: result.operationId };
        } catch (error) {
          return {
            entries,
            libraryUpdated,
            applied: false,
            operationId: apply.operationId,
            applyError: errorText(error),
          };
        }
      });
    return apply ? this.hostLocked(perform) : perform();
  }
  async applyPreview(input: RpcInput<typeof contracts.applyPreview>) {
    const store = await this.store(input.libraryRoot);
    const before = await this.live();
    let profiles: Profile[], sourceName: string, entry: LibraryEntry | undefined;
    if (input.importPreviewId) {
      const plan = this.plan(this.imports, input.importPreviewId, store);
      if (plan.items.length !== 1) throw new Error("Update and use reviews one pack at a time");
      const item = plan.items[0];
      profiles =
        item.sourceUnchanged && item.target ? item.target.set.profiles : item.incoming.profiles;
      sourceName = item.incoming.name;
    } else if (input.snapshotId) {
      if (input.mode !== "restore") throw new Error("Recovery snapshots require restore mode");
      const snapshot = await readJson<Snapshot>(
        path.join(store.state, "snapshots", `${input.snapshotId}.json`),
      );
      if (!snapshot) throw new Error("Recovery snapshot not found");
      profiles = ProfilesSchema.parse(snapshot.profiles);
      sourceName = "Previous agent-profile list";
    } else {
      if (!input.localId) throw new Error("Choose a saved pack");
      entry = await store.read(input.localId);
      profiles = entry.set.profiles;
      sourceName = entry.set.name;
    }
    let target = profiles;
    if (input.mode === "add") {
      if (!input.selections?.length)
        throw new Error("Select profiles and resolve collisions first");
      target = [...before];
      const seen = new Set<string>(),
        replaced = new Set<string>();
      for (const selection of input.selections) {
        if (seen.has(selection.profileId)) throw new Error("Duplicate profile selection");
        seen.add(selection.profileId);
        const profile = profiles.find((p) => p.id === selection.profileId);
        if (!profile) throw new Error("Selected source profile not found");
        if (selection.action === "skip") continue;
        if (selection.action === "replace") {
          const targetId = selection.targetId ?? profile.id;
          if (replaced.has(targetId)) throw new Error("Several selections replace the same target");
          replaced.add(targetId);
          const index = target.findIndex((p) => p.id === targetId);
          if (index < 0) throw new Error("Replacement target no longer exists");
          target[index] = { ...profile, id: targetId };
        } else if (selection.action === "keep-both")
          target.push({ ...profile, id: randomUUID(), name: `${profile.name} (copy)` });
        else {
          if (target.some((p) => p.id === profile.id))
            throw new Error("Profile ID collision; choose Keep both or Replace");
          target.push(profile);
        }
      }
    }
    target = ProfilesSchema.parse(target);
    const plan = this.remember(this.applies, {
      id: randomUUID(),
      root: store.root,
      expires: Date.now() + 15 * 60_000,
      before,
      target,
      beforeHash: hash(before),
      sourceName,
      localId: entry?.localId,
      revision: entry?.revision,
      importPreviewId: input.importPreviewId,
      snapshotId: input.snapshotId,
    });
    return {
      previewId: plan.id,
      before,
      target,
      diff: profilesDiff(before, target),
      warnings: await this.warnings(target),
      sourceName,
    };
  }
  private async hostLocked<T>(action: () => Promise<T>): Promise<T> {
    const pending = this.activationQueue.then(() =>
      withDirectoryLock(
        path.join(this.home, "plugin-data/paseo-profiles/state/activation.lock"),
        action,
      ),
    );
    this.activationQueue = pending.catch(() => {});
    return pending;
  }
  private async checkApply(store: LibraryStore, plan: ApplyPlan, combined = false) {
    await this.store(plan.root, false);
    if (plan.committed)
      throw new Error(
        "This apply review was already submitted. Inspect current profiles and recovery.",
      );
    if (plan.localId) await store.assertRevision(plan.localId, plan.revision);
    if (plan.importPreviewId && !combined)
      throw new Error("Update and use must be committed through the import review");
    if (hash(await this.live()) !== plan.beforeHash)
      throw new Error("Current agent profiles changed. Create a fresh preview.");
  }
  async applyCommit(input: RpcInput<typeof contracts.applyCommit>) {
    const store = await this.store(input.libraryRoot);
    const plan = this.plan(this.applies, input.previewId, store);
    return this.hostLocked(() =>
      store.locked(async () => {
        await this.checkApply(store, plan);
        return this.applyUnlocked(store, plan);
      }),
    );
  }
  private async applyUnlocked(store: LibraryStore, plan: ApplyPlan) {
    const id = randomUUID();
    plan.operationId = id;
    plan.committed = true;
    const operation: Operation = {
      id,
      createdAt: new Date().toISOString(),
      status: "prepared",
      sourceName: plan.sourceName,
      libraryRoot: store.root,
      sourceRevision: plan.revision,
      target: plan.target,
      beforeHash: plan.beforeHash,
      targetHash: hash(plan.target),
    };
    const file = path.join(store.state, "operations", `${id}.json`);
    try {
      await this.fault("beforeSnapshotWrite");
      await writeJson(
        path.join(store.state, "snapshots", `${id}.json`),
        { id, createdAt: operation.createdAt, profiles: plan.before },
        true,
      );
      await this.fault("beforeJournalWrite");
      await writeJson(file, operation, true);
      await this.store(plan.root, false);
      if (hash(await this.live()) !== plan.beforeHash)
        throw new Error("Current profiles changed before application. Review again.");
      await this.fault("beforeConfigPatch");
      const response = await this.paseo.config.patch({ agentProfiles: plan.target });
      await this.fault("afterConfigPatch");
      if (
        hash(ProfilesSchema.parse(response.config.agentProfiles ?? [])) !== operation.targetHash ||
        hash(await this.live()) !== operation.targetHash
      )
        throw new Error("Applied result differs from the reviewed target; inspect recovery");
      operation.status = "complete";
      await this.fault("beforeCompletionWrite");
      await writeJson(file, operation);
      return { operationId: id, profiles: plan.target };
    } catch (error) {
      operation.status = "uncertain";
      operation.error = errorText(error);
      // Do not manufacture an operation file when preservation itself failed.
      if (await readJson(file).catch(() => undefined))
        await writeJson(file, operation).catch(() => {});
      throw new Error(
        `Application did not complete (${id}): ${errorText(error)}. Refresh current profiles and inspect recovery before retrying.`,
      );
    }
  }
  async historyList(input: RpcInput<typeof contracts.historyList>) {
    return (await this.store(input.libraryRoot)).history(input.localId);
  }
  async restoreHistory(input: RpcInput<typeof contracts.restoreHistory>) {
    return (await this.store(input.libraryRoot)).restore(
      input.localId,
      input.revision,
      input.expectedRevision,
    );
  }
  async recoveryList(input: RpcInput<typeof contracts.recoveryList>) {
    const store = await this.store(input.libraryRoot);
    return this.hostLocked(async () => {
      const liveHash = hash(await this.live());
      const operations: Operation[] = [],
        snapshots: { id: string; createdAt: string; profileCount: number }[] = [];
      for (const kind of ["operations", "snapshots"] as const) {
        const directory = path.join(store.state, kind);
        let names: string[];
        try {
          names = await fs.readdir(directory);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        for (const name of names.filter((n) => n.endsWith(".json"))) {
          const file = path.join(directory, name);
          if (kind === "snapshots") {
            const snapshot = await readJson<Snapshot>(file);
            if (snapshot)
              snapshots.push({
                id: snapshot.id,
                createdAt: snapshot.createdAt,
                profileCount: ProfilesSchema.parse(snapshot.profiles).length,
              });
          } else {
            const operation = await readJson<Operation>(file);
            if (!operation) continue;
            if (operation.status !== "complete") {
              operation.status =
                liveHash === operation.targetHash
                  ? "complete"
                  : liveHash === operation.beforeHash
                    ? "not-applied"
                    : "ambiguous";
              await writeJson(file, operation);
            }
            operations.push(operation);
          }
        }
      }
      return {
        operations: operations.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
        snapshots: snapshots.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      };
    });
  }
}
