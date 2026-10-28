import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  type GistPointer,
  type GistSidecar,
  GistSidecarSchema,
  type HostLinkRecord,
  HostLinkRecordSchema,
} from "../shared/gist";
import { atomicWrite, expandPath, readJson, regularFile, writeJson } from "./files";
import type { LibraryStore } from "./library-store";

/** Directory inside a Git worktree that the plugin owns and writes sidecars into. */
export const SIDECAR_DIRECTORY = path.join(".paseo-profiles", "gists");

/** Pack IDs are arbitrary non-empty strings, so the filename is a hash and never the raw ID. */
export const sidecarFileName = (packId: string) =>
  `${createHash("sha256").update(packId).digest("hex")}.json`;
export const sidecarPath = (repository: string, packId: string) =>
  path.join(repository, SIDECAR_DIRECTORY, sidecarFileName(packId));

export function parseSidecar(text: string, expectedPackId: string): GistSidecar {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("The Gist link sidecar is not valid JSON.");
  }
  const parsed = GistSidecarSchema.safeParse(value);
  if (!parsed.success) throw new Error("The Gist link sidecar has an unsupported format.");
  if (parsed.data.packId !== expectedPackId)
    throw new Error("The Gist link sidecar belongs to a different pack.");
  return parsed.data;
}

const MAX_SIDECAR_BYTES = 16_000;
const execGit = promisify(execFile);

/** Resolves an entered directory to the root of its Git working tree on this host. */
export async function resolveRepository(input: string): Promise<string> {
  const entered = expandPath(input.trim());
  let real: string;
  try {
    real = await fs.realpath(entered);
  } catch {
    throw new Error("The repository folder does not exist on this Paseo host.");
  }
  if (!(await fs.stat(real)).isDirectory()) throw new Error("The repository path is not a folder.");
  try {
    const { stdout } = await execGit("git", ["-C", real, "rev-parse", "--show-toplevel"], {
      timeout: 10_000,
      windowsHide: true,
      maxBuffer: 64_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    const top = stdout.trim();
    if (!top) throw new Error("empty");
    return await fs.realpath(top);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error("Git is not installed or is not on this Paseo host's PATH.");
    throw new Error("That folder is not inside a Git working tree on this Paseo host.");
  }
}

// The plugin only writes under its own directory; refuse links that could redirect writes elsewhere.
async function assertOwnedDirectory(repository: string, create: boolean): Promise<string> {
  let current = repository;
  for (const part of SIDECAR_DIRECTORY.split(path.sep)) {
    current = path.join(current, part);
    const stat = await fs.lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (stat && (stat.isSymbolicLink() || !stat.isDirectory()))
      throw new Error(`${current} must be a regular folder, not a link.`);
    if (!stat && create) await fs.mkdir(current, { mode: 0o755 });
    if (!stat && !create) return current;
  }
  return current;
}

export async function readSidecar(
  repository: string,
  packId: string,
): Promise<GistSidecar | undefined> {
  const directory = await assertOwnedDirectory(repository, false);
  const file = path.join(directory, sidecarFileName(packId));
  try {
    await regularFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if ((await fs.stat(file)).size > MAX_SIDECAR_BYTES)
    throw new Error("The Gist link sidecar is larger than expected.");
  return parseSidecar(await fs.readFile(file, "utf8"), packId);
}

export async function writeSidecar(repository: string, sidecar: GistSidecar): Promise<string> {
  GistSidecarSchema.parse(sidecar);
  const directory = await assertOwnedDirectory(repository, true);
  const file = path.join(directory, sidecarFileName(sidecar.packId));
  await atomicWrite(file, `${JSON.stringify(sidecar, null, 2)}\n`);
  return file;
}

/** Removes only a sidecar this plugin wrote for this pack, optionally only if it still has `expected`. */
export async function removeSidecar(
  repository: string,
  packId: string,
  expected?: GistPointer,
): Promise<boolean> {
  const current = await readSidecar(repository, packId);
  if (!current) return false;
  if (
    expected &&
    (current.gistId.toLowerCase() !== expected.gistId.toLowerCase() ||
      current.fileName !== expected.fileName)
  )
    return false;
  await fs.unlink(sidecarPath(repository, packId));
  return true;
}

/** Host-local link records and baseline text for one library. */
export class GistLinkStore {
  constructor(private readonly store: LibraryStore) {}
  recordPath(localId: string) {
    this.store.file(localId);
    return path.join(this.store.state, "gist-links", `${localId}.json`);
  }
  baselinePath(localId: string) {
    this.store.file(localId);
    return path.join(this.store.state, "gist-baselines", `${localId}.yaml`);
  }
  async read(localId: string): Promise<HostLinkRecord | undefined> {
    const value = await readJson<unknown>(this.recordPath(localId));
    if (value === undefined) return undefined;
    const parsed = HostLinkRecordSchema.safeParse(value);
    if (!parsed.success) throw new Error(`Gist link state for ${localId} is unreadable.`);
    return parsed.data;
  }
  async write(record: HostLinkRecord) {
    await writeJson(this.recordPath(record.localId), HostLinkRecordSchema.parse(record));
  }
  async readBaselineText(localId: string): Promise<string | undefined> {
    try {
      await regularFile(this.baselinePath(localId));
      return await fs.readFile(this.baselinePath(localId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
  async writeBaselineText(localId: string, text: string | undefined) {
    if (text === undefined)
      await fs.unlink(this.baselinePath(localId)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    else await atomicWrite(this.baselinePath(localId), text);
  }
}
