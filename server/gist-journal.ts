import * as fs from "node:fs/promises";
import path from "node:path";
import type { GistOperation, GistPointer, GistStorage } from "../shared/gist";
import { errorText, readJson, writeJson } from "./files";
import type { GistAccount } from "./gists";
import type { LibraryStore } from "./library-store";

export type JournalStatus = GistOperation["status"];
export interface PublishJournal {
  version: 1;
  id: string;
  kind: "revision" | "new";
  status: JournalStatus;
  createdAt: string;
  updatedAt: string;
  localId: string;
  packId: string;
  localRevision: string;
  storage: GistStorage;
  repository?: string;
  fileName: string;
  account: GistAccount;
  confirmTarget: boolean;
  /** The target (existing Gist for a revision; the created Gist once known). */
  gist?: {
    id: string;
    url: string;
    public: boolean;
    ownerId: number;
    ownerLogin: string;
    revision?: string;
  };
  newGist?: { public: boolean; description: string };
  /** The exact bound-file text the operation intends to leave on GitHub. */
  payload: { text: string; hash: string; contentHash: string };
  /** Portable create: the first POST body has no pointer; `payload` is the final embedded text. */
  firstText?: { text: string; hash: string };
  /** Which remote step is outstanding while status is sending/unknown. */
  step: "write" | "create" | "embed";
  expectedRemote?: { fileHash?: string; revision?: string };
  /** Active links this operation replaces, recorded as previous links when it completes. */
  replaced?: GistPointer[];
  pendingFirstPublish?: boolean;
  revision?: string;
  confirmedBy?: "response" | "readback" | "content-match" | "adopted";
  error?: string;
  alreadyCurrent?: boolean;
}

export const UNRESOLVED: JournalStatus[] = [
  "prepared",
  "sending",
  "created",
  "remote-confirmed",
  "unknown",
];

export class GistJournal {
  constructor(private readonly store: LibraryStore) {}
  private file(id: string) {
    if (!/^[a-zA-Z0-9-]{8,64}$/.test(id)) throw new Error("Invalid operation ID");
    return path.join(this.store.state, "gist-operations", `${id}.json`);
  }
  async create(journal: PublishJournal) {
    await writeJson(this.file(journal.id), journal, true);
  }
  async save(journal: PublishJournal, now: string) {
    journal.updatedAt = now;
    await writeJson(this.file(journal.id), journal);
  }
  async read(id: string): Promise<PublishJournal | undefined> {
    return readJson<PublishJournal>(this.file(id));
  }
  async list(): Promise<PublishJournal[]> {
    const directory = path.join(this.store.state, "gist-operations");
    let names: string[];
    try {
      names = await fs.readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const journals: PublishJournal[] = [];
    for (const name of names.filter((n) => n.endsWith(".json"))) {
      // Fail closed: an unreadable journal could hide an unresolved write, so never skip it.
      const journal = await readJson<PublishJournal>(path.join(directory, name)).catch(
        (error: unknown) => {
          throw new Error(
            `Gist publication record ${name} is unreadable (${errorText(error)}). Inspect ${directory} before publishing again.`,
          );
        },
      );
      if (journal) journals.push(journal);
    }
    return journals.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async unresolved(localId?: string) {
    return (await this.list()).filter(
      (j) => UNRESOLVED.includes(j.status) && (localId === undefined || j.localId === localId),
    );
  }
}
