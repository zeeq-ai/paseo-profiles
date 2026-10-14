import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { canonicalJson } from "../shared/canonical";

export type Fault = (stage: string) => void | Promise<void>;
export const hash = (value: unknown) =>
  `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
export const rawHash = (value: string) => createHash("sha256").update(value).digest("hex");
export const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
export function expandPath(value: string): string {
  return path.resolve(
    value === "~"
      ? os.homedir()
      : value.startsWith("~/")
        ? path.join(os.homedir(), value.slice(2))
        : value,
  );
}
export const defaultHome = () => expandPath(process.env.PASEO_HOME ?? "~/.paseo");
export async function ensureDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
}
export async function regularFile(file: string): Promise<void> {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error("Expected a regular file, not a symbolic link");
}
export async function atomicWrite(file: string, text: string, exclusive = false): Promise<void> {
  await ensureDirectory(path.dirname(file));
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
    await handle.close();
    if (exclusive) {
      await fs.link(temporary, file);
      await fs.unlink(temporary);
    } else {
      await fs.rename(temporary, file);
    }
    // Directory fsync is supported on POSIX. Windows may reject directory handles.
    if (process.platform !== "win32") {
      const dir = await fs.open(path.dirname(file), "r");
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
    }
  } finally {
    await handle.close().catch(() => {});
    await fs.unlink(temporary).catch(() => {});
  }
}
export const writeJson = (file: string, value: unknown, exclusive = false) =>
  atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`, exclusive);
export async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    await regularFile(file);
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

// Locks are advisory and local-filesystem only. Never steal a possibly active lock.
// A killed process leaves an inspectable lock; remove it only after establishing its owner is gone.
export async function withDirectoryLock<T>(
  directory: string,
  action: () => Promise<T>,
): Promise<T> {
  await ensureDirectory(path.dirname(directory));
  const token = randomUUID();
  try {
    await fs.mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(
        `Storage is locked: ${directory}. Retry when the operation finishes; after a crash, verify the owner in owner.json is no longer running before removing this lock directory.`,
      );
    throw error;
  }
  try {
    await writeJson(
      path.join(directory, "owner.json"),
      { token, pid: process.pid, hostname: os.hostname(), createdAt: new Date().toISOString() },
      true,
    );
    return await action();
  } finally {
    const owner = await readJson<{ token: string }>(path.join(directory, "owner.json")).catch(
      () => undefined,
    );
    if (owner?.token === token) await fs.rm(directory, { recursive: true, force: true });
  }
}
