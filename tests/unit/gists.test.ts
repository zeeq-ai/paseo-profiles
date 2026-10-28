import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createGhGistGateway,
  createGist,
  GistTransportError,
  ghGistGateway,
  isWriteOutcomeUnknown,
  readGist,
} from "../../server/gists";
import { LIMITS } from "../../shared/set";
import { createFakeGh, type FakeGh } from "../support/fake-gh";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function withFakeGh(user?: { id: number; login: string }): Promise<FakeGh> {
  const gh = await createFakeGh(user);
  cleanups.push(() => gh.dispose());
  vi.stubEnv("PATH", gh.env.PATH);
  return gh;
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the operation to fail");
}

const PACK = "format: paseo-profile-set\nversion: 2\nid: pack-a\nname: A\n";

describe("Gist transport through a fake gh", () => {
  it("reports the effective GitHub identity, including a GH_TOKEN override", async () => {
    const gh = await withFakeGh({ id: 1001, login: "charles" });
    await gh.mutate((state) => {
      state.tokens["work-token"] = { id: 3003, login: "work-bot" };
    });

    expect(await ghGistGateway.account()).toEqual({ id: 1001, login: "charles" });
    vi.stubEnv("GH_TOKEN", "work-token");
    expect(await ghGistGateway.account()).toEqual({ id: 3003, login: "work-bot" });
  });

  it("surfaces a logged-out gh as an authentication failure that is not an unknown write", async () => {
    const gh = await withFakeGh();
    await gh.mutate((state) => {
      state.loggedOut = true;
    });

    const error = await failure(
      ghGistGateway.update({ gistId: "abcde", fileName: "a.yaml", text: PACK }),
    );

    expect(error).toBeInstanceOf(GistTransportError);
    expect((error as GistTransportError).status).toBe(401);
    expect(isWriteOutcomeUnknown(error)).toBe(false);
    expect((error as Error).message).toMatch(/gh auth login/);
  });

  it("reads owner, visibility, every file, and the newest revision", async () => {
    const gh = await withFakeGh();
    const gist = await gh.seed({
      owner: { id: 2002, login: "jamie" },
      public: true,
      files: { "a.yaml": PACK, "notes.md": "hello\n" },
    });
    await gh.edit(gist.id, "a.yaml", `${PACK}# edited\n`);
    const current = await gh.gist(gist.id);

    const read = await ghGistGateway.read(gist.id);

    expect(read.owner).toEqual({ id: 2002, login: "jamie" });
    expect(read.public).toBe(true);
    expect(read.files).toEqual([
      { name: "a.yaml", text: `${PACK}# edited\n` },
      { name: "notes.md", text: "hello\n" },
    ]);
    expect(read.revision).toBe(current.history[0]?.version);
    expect(read.revision).not.toBe(gist.history[0]?.version);
  });

  it("rejects a file that GitHub truncated and a truncated file list", async () => {
    const gh = await withFakeGh();
    const gist = await gh.seed({ files: { "a.yaml": PACK } });
    await gh.mutate((state) => {
      const file = state.gists[gist.id]?.files["a.yaml"];
      if (file) file.truncated = true;
    });
    expect((await failure(ghGistGateway.read(gist.id))) as Error).toMatchObject({
      message: expect.stringMatching(/too large/),
    });

    await gh.mutate((state) => {
      const target = state.gists[gist.id];
      if (!target) return;
      const file = target.files["a.yaml"];
      if (file) file.truncated = false;
      target.responseTruncated = true;
    });
    expect((await failure(ghGistGateway.read(gist.id))) as Error).toMatchObject({
      message: expect.stringMatching(/truncated/),
    });
  });

  it("PATCHes only the named file's content and leaves everything else on the Gist alone", async () => {
    const gh = await withFakeGh();
    const gist = await gh.seed({
      description: "My packs",
      files: { "a.yaml": PACK, "b.yaml": "b: 1\n", "notes.md": "readme\n" },
    });
    await gh.clearRequests();

    const result = await ghGistGateway.update({
      gistId: gist.id,
      fileName: "a.yaml",
      text: `${PACK}# v2\n`,
    });

    const writes = await gh.writes();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      method: "PATCH",
      path: `gists/${gist.id}`,
      hostname: "github.com",
      body: { files: { "a.yaml": { content: `${PACK}# v2\n` } } },
    });
    // No description, visibility, rename or deletion key travels with the write.
    const sent = (writes[0]?.body ?? {}) as { files?: object };
    expect(Object.keys(sent)).toEqual(["files"]);
    expect(Object.keys(sent.files ?? {})).toEqual(["a.yaml"]);
    const after = await gh.gist(gist.id);
    expect(after.files["b.yaml"]?.content).toBe("b: 1\n");
    expect(after.files["notes.md"]?.content).toBe("readme\n");
    expect(after.description).toBe("My packs");
    expect(result.files.find((file) => file.name === "a.yaml")?.text).toBe(`${PACK}# v2\n`);
    expect(result.revision).toBe(after.history[0]?.version);
  });

  it("reads and updates a bound file despite unrelated truncated files or many YAML files", async () => {
    const gh = await withFakeGh();
    const gist = await gh.seed({
      files: {
        "a.yaml": PACK,
        "large.md": "unrelated",
        ...Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`other-${i}.yaml`, "x: 1\n"])),
      },
    });
    await gh.mutate((state) => {
      const file = state.gists[gist.id]?.files["large.md"];
      if (file) file.truncated = true;
    });
    const selected = await ghGistGateway.read(gist.id, "a.yaml");
    expect(selected.files).toEqual([{ name: "a.yaml", text: PACK }]);
    expect(selected.fileCount).toBe(19);
    expect(
      await readGist({ url: `https://gist.github.com/${gist.id}`, fileName: "a.yaml" }),
    ).toEqual({
      files: [{ name: "a.yaml", text: PACK }],
    });
    const updated = await ghGistGateway.update({
      gistId: gist.id,
      fileName: "a.yaml",
      text: `${PACK}# updated\n`,
    });
    expect(updated.files).toEqual([{ name: "a.yaml", text: `${PACK}# updated\n` }]);
    await expect(ghGistGateway.read(gist.id, "large.md")).rejects.toThrow(/too large/);
  });

  it("returns the existing revision when the payload is already identical", async () => {
    const gh = await withFakeGh();
    const gist = await gh.seed({ files: { "a.yaml": PACK } });

    const result = await ghGistGateway.update({ gistId: gist.id, fileName: "a.yaml", text: PACK });

    expect(result.revision).toBe(gist.history[0]?.version);
    expect((await gh.gist(gist.id)).history).toHaveLength(1);
  });

  it("treats a permission failure as a definite failure that left the Gist unchanged", async () => {
    const gh = await withFakeGh();
    const gist = await gh.seed({ owner: { id: 2002, login: "jamie" }, files: { "a.yaml": PACK } });

    const error = await failure(
      ghGistGateway.update({ gistId: gist.id, fileName: "a.yaml", text: `${PACK}# mine\n` }),
    );

    expect((error as GistTransportError).status).toBe(404);
    expect(isWriteOutcomeUnknown(error)).toBe(false);
    expect((await gh.gist(gist.id)).files["a.yaml"]?.content).toBe(PACK);
  });

  it("keeps a write whose response was lost classified as unknown even though it landed", async () => {
    const gh = await withFakeGh();
    const gist = await gh.seed({ files: { "a.yaml": PACK } });
    await gh.fault({ match: "^PATCH /gists/", applied: true, effect: { kind: "error" } });

    const error = await failure(
      ghGistGateway.update({ gistId: gist.id, fileName: "a.yaml", text: `${PACK}# v2\n` }),
    );

    expect(error).toBeInstanceOf(GistTransportError);
    expect((error as GistTransportError).requestSent).toBe(true);
    expect(isWriteOutcomeUnknown(error)).toBe(true);
    // The fault model really applied the write; the transport must not claim otherwise.
    expect((await gh.gist(gist.id)).files["a.yaml"]?.content).toBe(`${PACK}# v2\n`);
  });

  it("times out a hung write as unknown instead of retrying it", async () => {
    const gh = await withFakeGh();
    const gist = await gh.seed({ files: { "a.yaml": PACK } });
    await gh.fault({ match: "^PATCH /gists/", applied: true, effect: { kind: "hang" } });
    vi.stubEnv("PASEO_PROFILES_GH_TIMEOUT_MS", "700");
    await gh.clearRequests();

    const error = await failure(
      ghGistGateway.update({ gistId: gist.id, fileName: "a.yaml", text: `${PACK}# v2\n` }),
    );

    expect((error as GistTransportError).kind).toBe("timeout");
    expect(isWriteOutcomeUnknown(error)).toBe(true);
    expect(await gh.writes()).toHaveLength(1);
  });

  it("classifies a 5xx as unknown and a validation failure as definite", async () => {
    const gh = await withFakeGh();
    const gist = await gh.seed({ files: { "a.yaml": PACK } });
    await gh.fault({
      match: "^PATCH /gists/",
      effect: { kind: "error", status: 502, message: "Bad Gateway" },
    });
    const bad = await failure(
      ghGistGateway.update({ gistId: gist.id, fileName: "a.yaml", text: `${PACK}# v2\n` }),
    );
    expect((bad as GistTransportError).status).toBe(502);
    expect(isWriteOutcomeUnknown(bad)).toBe(true);

    await gh.fault({
      match: "^PATCH /gists/",
      effect: { kind: "error", status: 422, message: "Validation Failed" },
    });
    const invalid = await failure(
      ghGistGateway.update({ gistId: gist.id, fileName: "a.yaml", text: `${PACK}# v3\n` }),
    );
    expect(isWriteOutcomeUnknown(invalid)).toBe(false);
  });

  it("reports a missing gh as unavailable before any request is sent", async () => {
    const empty = await mkdtemp(path.join(tmpdir(), "paseo-profiles-no-gh-"));
    cleanups.push(() => rm(empty, { recursive: true, force: true }));
    vi.stubEnv("PATH", empty);

    const error = await failure(ghGistGateway.account());

    expect((error as GistTransportError).kind).toBe("unavailable");
    expect((error as GistTransportError).requestSent).toBe(false);
    expect(isWriteOutcomeUnknown(error)).toBe(false);
  });

  it("creates a secret Gist by default through the existing ad-hoc export and links nothing", async () => {
    const gh = await withFakeGh({ id: 1001, login: "charles" });

    const { url } = await createGist({
      files: [
        { name: "one.yaml", text: PACK },
        { name: "two.yaml", text: "b: 1\n" },
      ],
    });

    const requests = await gh.requests();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method: "POST", path: "gists", hostname: "github.com" });
    expect(requests[0]?.body).toMatchObject({ public: false });
    const [created] = Object.values((await gh.state()).gists);
    expect(Object.keys(created?.files ?? {})).toEqual(["one.yaml", "two.yaml"]);
    expect(url).toContain(created?.id);
    expect(created?.public).toBe(false);
  });

  it("lists only the account's own recent Gists, newest first, bounded by the limit", async () => {
    const gh = await withFakeGh({ id: 1001, login: "charles" });
    const first = await gh.seed({ files: { "a.yaml": PACK } });
    const second = await gh.seed({ files: { "b.yaml": PACK } });
    await gh.seed({ owner: { id: 2002, login: "jamie" }, files: { "c.yaml": PACK } });
    await gh.edit(first.id, "a.yaml", `${PACK}# newer\n`);
    await gh.clearRequests();

    const recent = await ghGistGateway.recent?.({ limit: 2 });

    expect(recent?.map((gist) => gist.id)).toEqual([first.id, second.id]);
    expect(recent?.[0]?.url).toBe(`https://gist.github.com/${first.id}`);
    expect(recent?.[0]?.updatedAt).toBeTruthy();
    const requests = await gh.requests();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.path).toMatch(/^gists\?per_page=2$/);
    expect(await ghGistGateway.recent?.({ limit: 1 })).toHaveLength(1);
  });

  it("validates file names and sizes before any request leaves the machine", async () => {
    const gh = await withFakeGh();
    await gh.clearRequests();

    for (const name of ["../escape.yaml", "dir/a.yaml", "", "a\u0000.yaml"]) {
      await expect(
        ghGistGateway.create({ files: [{ name, text: PACK }], description: "d", public: false }),
      ).rejects.toThrow();
    }
    await expect(
      ghGistGateway.create({
        files: [{ name: "big.yaml", text: "x".repeat(LIMITS.bytes + 1) }],
        description: "d",
        public: false,
      }),
    ).rejects.toThrow(/limit/);
    await expect(
      ghGistGateway.update({ gistId: "abcde", fileName: "../x", text: PACK }),
    ).rejects.toThrow();
    await expect(ghGistGateway.read("../user")).rejects.toThrow(/Invalid Gist ID/);
    expect(await gh.requests()).toEqual([]);
  });

  it("filters the existing import read to YAML and JSON files", async () => {
    const gh = await withFakeGh();
    const gist = await gh.seed({
      files: { "a.yaml": PACK, "b.json": "{}", "notes.md": "x", "c.yml": "c: 1\n" },
    });

    const { files } = await readGist({ url: `https://gist.github.com/someone/${gist.id}` });

    expect(files.map((file) => file.name)).toEqual(["a.yaml", "b.json", "c.yml"]);
    await expect(readGist({ url: `https://example.com/someone/${gist.id}` })).rejects.toThrow(
      /gist\.github\.com/,
    );
  });
});

describe("Gist gateway response validation with an injected runner", () => {
  const gistBody = (overrides: Record<string, unknown> = {}) =>
    JSON.stringify({
      id: "abcdef12",
      html_url: "https://gist.github.com/charles/abcdef12",
      public: false,
      truncated: false,
      owner: { id: 1, login: "charles" },
      files: { "a.yaml": { content: PACK, truncated: false } },
      history: [{ version: "a".repeat(40) }],
      ...overrides,
    });

  it("pins every request to github.com and never uses a jq filter", async () => {
    const calls: string[][] = [];
    const gateway = createGhGistGateway(async (args) => {
      calls.push(args);
      return args[1] === "user" ? JSON.stringify({ id: 1, login: "charles" }) : gistBody();
    });

    await gateway.account();
    await gateway.read("abcdef12");
    await gateway.update({ gistId: "abcdef12", fileName: "a.yaml", text: PACK });
    await gateway.create({
      files: [{ name: "a.yaml", text: PACK }],
      description: "d",
      public: false,
    });

    expect(calls).toHaveLength(4);
    for (const args of calls) {
      expect(args[args.indexOf("--hostname") + 1]).toBe("github.com");
      expect(args).not.toContain("--jq");
    }
  });

  it("flags an unreadable response to a sent write as unknown, not as failure", async () => {
    const gateway = createGhGistGateway(async () => "<html>gateway error</html>");

    const error = await failure(
      gateway.update({ gistId: "abcdef12", fileName: "a.yaml", text: PACK }),
    );

    expect((error as GistTransportError).kind).toBe("invalid-response");
    expect(isWriteOutcomeUnknown(error)).toBe(true);
  });

  it("rejects a response whose Gist identity differs from its URL", async () => {
    const gateway = createGhGistGateway(async () =>
      gistBody({ html_url: "https://gist.github.com/charles/ffffffff" }),
    );
    await expect(gateway.read("abcdef12")).rejects.toThrow();
  });

  it("rejects a response URL on any host other than gist.github.com", async () => {
    const gateway = createGhGistGateway(async () =>
      gistBody({ html_url: "https://evil.example.com/charles/abcdef12" }),
    );
    await expect(gateway.read("abcdef12")).rejects.toThrow();
  });

  it("rejects an account response without a numeric ID", async () => {
    const gateway = createGhGistGateway(async () => JSON.stringify({ login: "charles" }));
    await expect(gateway.account()).rejects.toThrow();
  });

  it("treats an unknown injected error conservatively as an unknown write outcome", () => {
    expect(isWriteOutcomeUnknown(new Error("socket hang up"))).toBe(true);
  });
});
