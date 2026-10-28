import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseSidecar,
  readSidecar,
  removeSidecar,
  resolveRepository,
  sidecarFileName,
  sidecarPath,
  writeSidecar,
} from "../../server/gist-link-store";

const run = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function temp(prefix: string) {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  roots.push(root);
  return root;
}
async function repository() {
  const root = await realpath(await temp("paseo-profiles-sidecar-"));
  await run("git", ["init", "--quiet", root]);
  return root;
}
const sidecar = (packId: string, overrides: Record<string, unknown> = {}) => ({
  format: "paseo-profile-gist-link" as const,
  version: 1 as const,
  packId,
  gistId: "3f9ac21e",
  fileName: "fast-review.yaml",
  ...overrides,
});

describe("repository sidecar", () => {
  it("names the file by the SHA-256 of the pack ID so no ID can escape the folder", () => {
    for (const packId of [
      "2dbfbd3d-81eb-4ab2-90a4-45dd2ef67e2b",
      "../../etc/passwd",
      "a/b\\c",
      "名前",
      " ",
    ]) {
      const name = sidecarFileName(packId);
      expect(name).toBe(`${createHash("sha256").update(packId).digest("hex")}.json`);
      expect(name).toMatch(/^[a-f0-9]{64}\.json$/);
    }
    expect(sidecarPath("/repo", "x")).toBe(
      path.join("/repo", ".paseo-profiles", "gists", sidecarFileName("x")),
    );
  });

  it("writes only under .paseo-profiles/gists and reads back exactly what it wrote", async () => {
    const repo = await repository();
    await writeFile(path.join(repo, "README.md"), "keep\n");
    const written = await writeSidecar(
      repo,
      sidecar("pack-1", {
        lastConfirmedRevision: "a".repeat(40),
        lastPublishedFileHash: `sha256:${"b".repeat(64)}`,
      }),
    );

    expect(written).toBe(sidecarPath(repo, "pack-1"));
    expect(await readSidecar(repo, "pack-1")).toEqual(
      sidecar("pack-1", {
        lastConfirmedRevision: "a".repeat(40),
        lastPublishedFileHash: `sha256:${"b".repeat(64)}`,
      }),
    );
    expect((await readdir(repo)).sort()).toEqual([".git", ".paseo-profiles", "README.md"]);
    // Nothing is staged or committed on the user's behalf.
    expect(
      (await run("git", ["-C", repo, "log", "--oneline"]).catch(() => ({ stdout: "" }))).stdout,
    ).toBe("");
    expect(await readdir(path.join(repo, ".paseo-profiles"))).toEqual(["gists"]);
    expect(await readFile(path.join(repo, "README.md"), "utf8")).toBe("keep\n");
  });

  it("stores no secrets or operation state in the shareable record", async () => {
    const repo = await repository();
    await writeSidecar(repo, sidecar("pack-1"));
    const text = await readFile(sidecarPath(repo, "pack-1"), "utf8");
    expect(Object.keys(JSON.parse(text)).sort()).toEqual(
      ["fileName", "format", "gistId", "packId", "version"].sort(),
    );
  });

  it("refuses a sidecar that names another pack, even if the filename matches", async () => {
    const repo = await repository();
    await writeSidecar(repo, sidecar("pack-1"));
    // Another clone (or a hand edit) put pack-2's record where pack-1's belongs.
    await writeFile(sidecarPath(repo, "pack-1"), JSON.stringify(sidecar("pack-2")));

    await expect(readSidecar(repo, "pack-1")).rejects.toThrow(/different pack/);
  });

  it.each([
    ["invalid JSON", "{nope"],
    ["an unknown field", JSON.stringify(sidecar("p", { token: "ghp_secret" }))],
    ["an unknown version", JSON.stringify(sidecar("p", { version: 2 }))],
    [
      "a URL as the Gist ID",
      JSON.stringify(sidecar("p", { gistId: "https://gist.github.com/x/abc12" })),
    ],
    ["a malformed hash", JSON.stringify(sidecar("p", { lastPublishedFileHash: "md5:zz" }))],
  ])("rejects a sidecar with %s", (_label, text) => {
    expect(() => parseSidecar(text, "p")).toThrow();
  });

  it("reports a missing sidecar as absent, not as an error", async () => {
    const repo = await repository();
    expect(await readSidecar(repo, "never-linked")).toBeUndefined();
    // Reading must not create the plugin's directory in someone's repository.
    expect(await readdir(repo)).toEqual([".git"]);
  });

  it("will not write through a symbolic link planted at the plugin directory", async () => {
    const repo = await repository();
    const elsewhere = await temp("paseo-profiles-elsewhere-");
    await symlink(elsewhere, path.join(repo, ".paseo-profiles"), "dir");

    await expect(writeSidecar(repo, sidecar("pack-1"))).rejects.toThrow();
    expect(await readdir(elsewhere)).toEqual([]);
  });

  it("will not write through a symbolic link planted at the sidecar itself", async () => {
    const repo = await repository();
    const victim = path.join(await temp("paseo-profiles-victim-"), "victim.txt");
    await writeFile(victim, "do not touch\n");
    await mkdir(path.join(repo, ".paseo-profiles", "gists"), { recursive: true });
    await symlink(victim, sidecarPath(repo, "pack-1"));

    await writeSidecar(repo, sidecar("pack-1")).catch(() => undefined);

    expect(await readFile(victim, "utf8")).toBe("do not touch\n");
  });

  it("removes only the record it was asked to, and only if the pointer still matches", async () => {
    const repo = await repository();
    await writeSidecar(repo, sidecar("pack-1"));
    await writeSidecar(repo, sidecar("pack-2", { gistId: "abcde" }));

    expect(await removeSidecar(repo, "pack-1", { gistId: "ffff0", fileName: "other.yaml" })).toBe(
      false,
    );
    expect(await readSidecar(repo, "pack-1")).toBeDefined();
    expect(
      await removeSidecar(repo, "pack-1", { gistId: "3F9AC21E", fileName: "fast-review.yaml" }),
    ).toBe(true);
    expect(await readSidecar(repo, "pack-1")).toBeUndefined();
    expect(await readSidecar(repo, "pack-2")).toBeDefined();
    expect((await lstat(sidecarPath(repo, "pack-2"))).isFile()).toBe(true);
  });
});

describe("repository resolution", () => {
  it("resolves a folder inside a worktree to the worktree root", async () => {
    const repo = await repository();
    const nested = path.join(repo, "profiles", "team");
    await mkdir(nested, { recursive: true });

    expect(await resolveRepository(nested)).toBe(repo);
  });

  it("does not accept a stray folder that is merely named .git", async () => {
    const fake = await temp("paseo-profiles-fake-git-");
    await mkdir(path.join(fake, ".git"));
    await expect(resolveRepository(fake)).rejects.toThrow(/Git working tree/);
  });

  it("rejects a folder outside any Git worktree, a missing folder, and a file", async () => {
    const plain = await temp("paseo-profiles-plain-");
    await expect(resolveRepository(plain)).rejects.toThrow(/Git working tree/);
    await expect(resolveRepository(path.join(plain, "missing"))).rejects.toThrow(/does not exist/);
    const file = path.join(plain, "file.txt");
    await writeFile(file, "x");
    await expect(resolveRepository(file)).rejects.toThrow(/not a folder/);
  });
});
