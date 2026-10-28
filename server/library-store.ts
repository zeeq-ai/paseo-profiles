import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { LIMITS, type LibraryEntry, type ProfileSet, SetSchema } from "../shared/set";
import {
  atomicWrite,
  ensureDirectory,
  errorText,
  expandPath,
  type Fault,
  hash,
  rawHash,
  readJson,
  regularFile,
  withDirectoryLock,
  writeJson,
} from "./files";
import { parseSet, serializeSet } from "./yaml";

export interface ImportMetadata {
  sourceSetId: string;
  originFingerprint?: string;
  baseline: ProfileSet;
  baselineHash: string;
}
interface LibraryJournal {
  id: string;
  localId: string;
  createdAt: string;
  status: string;
  beforeRevision?: string;
  targetRevision?: string;
  targetText?: string;
  beforeMetadataHash?: string;
  metadata?: ImportMetadata | null;
  delete?: boolean;
  error?: string;
}
export class LibraryStore {
  root: string;
  state: string;
  private readonly home: string;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly fault: Fault;
  constructor(options: { home: string; root?: string; fault?: Fault }) {
    this.home = options.home;
    this.root = expandPath(
      options.root || path.join(options.home, "plugin-data/paseo-profiles/sets"),
    );
    this.state = path.join(
      options.home,
      "plugin-data/paseo-profiles/state/libraries",
      rawHash(this.root),
    );
    this.fault = options.fault ?? (() => {});
  }
  async initialize() {
    await ensureDirectory(this.root);
    this.root = await fs.realpath(this.root);
    this.state = path.join(
      this.home,
      "plugin-data/paseo-profiles/state/libraries",
      rawHash(this.root),
    );
    await ensureDirectory(this.state);
  }
  file(localId: string) {
    if (!/^[a-zA-Z0-9_-]+$/.test(localId)) throw new Error("Invalid local pack ID");
    return path.join(this.root, `${localId}.yaml`);
  }
  async locked<T>(action: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(async () => {
      await this.initialize();
      return withDirectoryLock(path.join(this.root, ".paseo-profiles.lock"), async () => {
        await this.recoverLibraryUnlocked();
        return action();
      });
    });
    this.queue = pending.catch(() => {});
    return pending;
  }
  async read(localId: string): Promise<LibraryEntry> {
    const file = this.file(localId);
    await regularFile(file);
    const stat = await fs.stat(file);
    if (stat.size > LIMITS.bytes) throw new Error("Pack exceeds file size limit");
    const text = await fs.readFile(file, "utf8");
    const { set, hasIdentity } = parseSet(text);
    if (!hasIdentity)
      throw new Error(
        "Library entries require a portable profile-pack identity; import this file first",
      );
    return { localId, revision: rawHash(text), contentHash: hash(set), set };
  }
  async list() {
    await this.initialize();
    const entries: LibraryEntry[] = [],
      errors: { name: string; error: string }[] = [];
    const files = (await fs.readdir(this.root))
      .filter((name) => name.endsWith(".yaml") || name.endsWith(".yml"))
      .sort();
    for (const name of files) {
      try {
        if (!name.endsWith(".yaml")) throw new Error("Use a .yaml extension for library entries");
        entries.push(await this.read(name.slice(0, -5)));
      } catch (error) {
        errors.push({ name, error: errorText(error) });
      }
    }
    return { libraryRoot: this.root, entries, errors };
  }
  async inventoryHash() {
    const result = await this.list();
    return hash({
      entries: await Promise.all(
        result.entries.map(async (e) => [
          e.localId,
          e.revision,
          (await this.metadata(e.localId)) ?? null,
        ]),
      ),
      errors: result.errors,
    });
  }
  async metadata(localId: string) {
    await this.initialize();
    this.file(localId);
    return readJson<ImportMetadata>(path.join(this.state, "imports", `${localId}.json`));
  }
  async assertRevision(localId: string, expected?: string) {
    if (!expected) throw new Error("An expected revision is required to replace a saved pack");
    const entry = await this.read(localId);
    if (entry.revision !== expected)
      throw new Error("Saved pack changed since the preview. Refresh and review again.");
    return entry;
  }
  async save(
    set: ProfileSet,
    localId?: string,
    expectedRevision?: string,
    metadata?: ImportMetadata | null,
  ): Promise<LibraryEntry> {
    return this.locked(() => this.saveUnlocked(set, localId, expectedRevision, metadata));
  }
  async saveUnlocked(
    set: ProfileSet,
    localId?: string,
    expectedRevision?: string,
    metadata?: ImportMetadata | null,
  ): Promise<LibraryEntry> {
    set = SetSchema.parse(set);
    const updating = localId !== undefined;
    const chosen = localId ?? randomUUID();
    const before = updating ? await this.assertRevision(chosen, expectedRevision) : undefined;
    if (before && before.set.id !== set.id)
      throw new Error(
        "A saved pack keeps its ID when it is updated. Duplicate it or import as a copy to create a new pack.",
      );
    const text = serializeSet(set);
    const journal: LibraryJournal = {
      id: randomUUID(),
      localId: chosen,
      createdAt: new Date().toISOString(),
      status: "prepared",
      beforeRevision: before?.revision,
      targetRevision: rawHash(text),
      targetText: text,
      beforeMetadataHash: hash((await this.metadata(chosen)) ?? null),
      metadata,
    };
    const journalFile = path.join(this.state, "library-operations", `${journal.id}.json`);
    await writeJson(journalFile, journal, true);
    try {
      if (before) await this.archive(chosen, before.revision);
      await this.fault("beforeHeadWrite");
      if (before) await this.assertRevision(chosen, expectedRevision);
      await atomicWrite(this.file(chosen), text, !updating);
      journal.status = "head-written";
      await writeJson(journalFile, journal);
      await this.fault("afterHeadWrite");
      if (metadata !== undefined) {
        await this.fault("beforeMetadataWrite");
        await this.writeMetadata(chosen, metadata);
      }
      journal.status = "complete";
      await writeJson(journalFile, journal);
      return this.read(chosen);
    } catch (error) {
      journal.error = errorText(error);
      await writeJson(journalFile, journal).catch(() => {});
      throw error;
    }
  }
  private async writeMetadata(localId: string, metadata: ImportMetadata | null) {
    const file = path.join(this.state, "imports", `${localId}.json`);
    if (metadata === null)
      await fs.unlink(file).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    else await writeJson(file, metadata);
  }
  async archive(localId: string, revision: string) {
    const history = path.join(this.state, "history", localId);
    const text = await fs.readFile(this.file(localId), "utf8");
    if (rawHash(text) !== revision) throw new Error("Pack changed while preserving history");
    const versionId = `${revision}-${randomUUID()}`;
    await atomicWrite(path.join(history, `${versionId}.yaml`), text, true);
    await writeJson(
      path.join(history, `${versionId}.json`),
      { createdAt: new Date().toISOString(), metadata: await this.metadata(localId) },
      true,
    );
  }
  async setMetadataUnlocked(localId: string, metadata: ImportMetadata) {
    const current = await this.read(localId);
    // Metadata-only imports retain a complete head and previous provenance in history.
    await this.archive(localId, current.revision);
    const journal: LibraryJournal = {
      id: randomUUID(),
      localId,
      createdAt: new Date().toISOString(),
      status: "prepared",
      beforeRevision: current.revision,
      targetRevision: current.revision,
      beforeMetadataHash: hash((await this.metadata(localId)) ?? null),
      metadata,
    };
    const file = path.join(this.state, "library-operations", `${journal.id}.json`);
    await writeJson(file, journal, true);
    await this.fault("beforeMetadataWrite");
    await writeJson(path.join(this.state, "imports", `${localId}.json`), metadata);
    journal.status = "complete";
    await writeJson(file, journal);
  }
  async remove(localId: string, expectedRevision: string) {
    return this.locked(async () => {
      const entry = await this.assertRevision(localId, expectedRevision);
      await this.archive(localId, entry.revision);
      const journal: LibraryJournal = {
        id: randomUUID(),
        localId,
        createdAt: new Date().toISOString(),
        status: "prepared",
        beforeRevision: entry.revision,
        beforeMetadataHash: hash((await this.metadata(localId)) ?? null),
        delete: true,
      };
      const file = path.join(this.state, "library-operations", `${journal.id}.json`);
      await writeJson(file, journal, true);
      await this.assertRevision(localId, expectedRevision);
      await fs.unlink(this.file(localId));
      await fs.unlink(path.join(this.state, "imports", `${localId}.json`)).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
      journal.status = "complete";
      await writeJson(file, journal);
      return { deleted: true as const };
    });
  }
  async history(localId: string) {
    await this.initialize();
    this.file(localId);
    const directory = path.join(this.state, "history", localId);
    let names: string[];
    try {
      names = await fs.readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { versions: [] };
      throw error;
    }
    const versions = [];
    for (const name of names.filter((n) => n.endsWith(".yaml"))) {
      const revision = name.slice(0, -5);
      const { set } = parseSet(await fs.readFile(path.join(directory, name), "utf8"));
      const meta = await readJson<{ createdAt: string }>(path.join(directory, `${revision}.json`));
      versions.push({ revision, name: set.name, createdAt: meta?.createdAt ?? "" });
    }
    return { versions: versions.sort((a, b) => b.createdAt.localeCompare(a.createdAt)) };
  }
  async restore(localId: string, revision: string, expectedRevision: string) {
    await this.initialize();
    if (!/^[a-zA-Z0-9_-]+$/.test(revision)) throw new Error("Invalid history revision");
    const file = path.join(this.state, "history", localId, `${revision}.yaml`);
    this.file(localId);
    await regularFile(file);
    const { set } = parseSet(await fs.readFile(file, "utf8"));
    const previous = await readJson<{ metadata?: ImportMetadata }>(
      path.join(this.state, "history", localId, `${revision}.json`),
    );
    return this.save(set, localId, expectedRevision, previous?.metadata ?? null);
  }
  async recoverLibrary() {
    return this.locked(async () => {});
  }
  private async recoverLibraryUnlocked() {
    const directory = path.join(this.state, "library-operations");
    let names: string[];
    try {
      names = await fs.readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const records = await Promise.all(
      names
        .filter((n) => n.endsWith(".json"))
        .map(async (name) => ({
          file: path.join(directory, name),
          journal: await readJson<LibraryJournal>(path.join(directory, name)),
        })),
    );
    for (const { file, journal } of records) {
      if (!journal || ["complete", "not-applied", "superseded"].includes(journal.status)) continue;
      // A historical unresolved record never rewinds a later successful operation.
      if (
        records.some(
          (record) =>
            record.journal?.localId === journal.localId &&
            record.journal.status === "complete" &&
            record.journal.createdAt > journal.createdAt,
        )
      ) {
        journal.status = "superseded";
        await writeJson(file, journal);
        continue;
      }
      if (journal.status === "ambiguous")
        throw new Error(
          `Library recovery requires inspection: ${file}. The saved head or provenance diverged; no pending metadata was replayed.`,
        );
      let revision: string | undefined;
      try {
        revision = (await this.read(journal.localId)).revision;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          journal.status = "ambiguous";
          journal.error = errorText(error);
          await writeJson(file, journal);
          throw new Error(`Library recovery requires inspection: ${file}: ${journal.error}`);
        }
      }
      const currentMetadataHash = hash((await this.metadata(journal.localId)) ?? null);
      const desiredMetadataHash = hash(journal.metadata ?? null);
      const canReplayMetadata =
        (journal.beforeMetadataHash === undefined && currentMetadataHash === hash(null)) ||
        currentMetadataHash === journal.beforeMetadataHash;
      if (journal.delete && !revision && canReplayMetadata) {
        await fs
          .unlink(path.join(this.state, "imports", `${journal.localId}.json`))
          .catch(() => {});
        journal.status = "complete";
      } else if (revision === journal.targetRevision) {
        if (
          journal.metadata !== undefined &&
          currentMetadataHash !== desiredMetadataHash &&
          !canReplayMetadata
        ) {
          journal.status = "ambiguous";
          journal.error = "Import metadata changed since the interrupted operation";
        } else {
          if (journal.metadata !== undefined && currentMetadataHash !== desiredMetadataHash)
            await this.writeMetadata(journal.localId, journal.metadata);
          journal.status = "complete";
        }
      } else if (revision === journal.beforeRevision) journal.status = "not-applied";
      else journal.status = "ambiguous";
      await writeJson(file, journal);
      if (journal.status === "ambiguous")
        throw new Error(
          `Library recovery requires inspection: ${file}. The saved head or provenance diverged; no pending metadata was replayed.`,
        );
    }
  }
}
