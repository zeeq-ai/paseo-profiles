import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeGh, type FakeGh } from "../support/fake-gh";

// These tests pin the GitHub semantics the fake models. A fake that drifts from GitHub would let
// publication tests pass for the wrong reason, so each case cites documented REST behavior.
const run = promisify(execFile);
const cleanups: FakeGh[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((gh) => gh.dispose()));
});

async function setup() {
  const gh = await createFakeGh();
  cleanups.push(gh);
  const call = async (args: string[], input?: string, env: Record<string, string> = {}) => {
    const child = run("gh", args, { env: { ...process.env, ...gh.env, ...env } });
    if (input !== undefined) child.child.stdin?.end(input);
    return child
      .then(({ stdout }) => ({ code: 0, stdout, stderr: "" }))
      .catch((error: { code: number; stdout: string; stderr: string }) => error);
  };
  const api = async (method: string, endpoint: string, body?: unknown) => {
    const args = ["api", endpoint, "--hostname", "github.com", "--method", method];
    if (body !== undefined) args.push("--input", "-");
    const result = await call(args, body === undefined ? undefined : JSON.stringify(body));
    return { ...result, json: result.stdout.trim() ? JSON.parse(result.stdout) : undefined };
  };
  return { gh, api, call };
}

describe("fake GitHub Gist semantics", () => {
  it("leaves omitted files and the description untouched when PATCH names one file", async () => {
    const { gh, api } = await setup();
    const gist = await gh.seed({
      description: "keep me",
      files: { "a.yaml": "a: 1\n", "notes.md": "unrelated\n" },
    });

    const result = await api("PATCH", `gists/${gist.id}`, {
      files: { "a.yaml": { content: "a: 2\n" } },
    });

    expect(result.code).toBe(0);
    const after = await gh.gist(gist.id);
    expect(after.files["notes.md"]?.content).toBe("unrelated\n");
    expect(after.files["a.yaml"]?.content).toBe("a: 2\n");
    expect(after.description).toBe("keep me");
    expect(after.history).toHaveLength(2);
  });

  it("does not create a revision for an unchanged payload", async () => {
    const { gh, api } = await setup();
    const gist = await gh.seed({ files: { "a.yaml": "a: 1\n" } });

    const result = await api("PATCH", `gists/${gist.id}`, {
      files: { "a.yaml": { content: "a: 1\n" } },
    });

    expect(result.code).toBe(0);
    expect(result.json.history).toHaveLength(1);
    expect(result.json.history[0].version).toBe(gist.history[0]?.version);
  });

  it("refuses PATCH by a non-owner without changing the Gist", async () => {
    const { gh, api } = await setup();
    const gist = await gh.seed({
      owner: { id: 2002, login: "jamie" },
      files: { "a.yaml": "a: 1\n" },
    });

    const result = await api("PATCH", `gists/${gist.id}`, {
      files: { "a.yaml": { content: "a: 2\n" } },
    });

    expect(result.code).not.toBe(0);
    expect((await gh.gist(gist.id)).files["a.yaml"]?.content).toBe("a: 1\n");
  });

  it("creates secret Gists by default and reports the authenticated owner", async () => {
    const { api } = await setup();
    const created = await api("POST", "gists", { files: { "a.yaml": { content: "a: 1\n" } } });

    expect(created.json.public).toBe(false);
    expect(created.json.owner.login).toBe("charles");
    expect(created.json.html_url).toBe(`https://gist.github.com/charles/${created.json.id}`);
    expect((await api("GET", "user")).json).toMatchObject({ id: 1001, login: "charles" });
  });

  it("serves a past revision's content and rejects an unknown revision", async () => {
    const { gh, api } = await setup();
    const gist = await gh.seed({ files: { "a.yaml": "a: 1\n" } });
    const first = gist.history[0]?.version ?? "";
    await gh.edit(gist.id, "a.yaml", "a: 2\n");

    const old = await api("GET", `gists/${gist.id}/${first}`);
    expect(old.json.files["a.yaml"].content).toBe("a: 1\n");
    expect((await api("GET", `gists/${gist.id}/${"0".repeat(40)}`)).code).not.toBe(0);
  });

  it("lets GH_TOKEN override the stored login, and rejects an unknown token", async () => {
    const { gh, call } = await setup();
    await gh.mutate((state) => {
      state.tokens.work = { id: 3003, login: "work-bot" };
    });
    const who = async (token: string) =>
      call(["api", "user", "--hostname", "github.com"], undefined, { GH_TOKEN: token });

    expect(JSON.parse((await who("work")).stdout).login).toBe("work-bot");
    const bad = await who("nope");
    expect(bad.code).not.toBe(0);
    expect(bad.stderr).toMatch(/HTTP 401/);
  });

  it("applies a lost-response fault after the write reached GitHub", async () => {
    const { gh, api } = await setup();
    const gist = await gh.seed({ files: { "a.yaml": "a: 1\n" } });
    await gh.fault({
      match: "^PATCH /gists/",
      applied: true,
      effect: { kind: "error" },
    });

    const lost = await api("PATCH", `gists/${gist.id}`, {
      files: { "a.yaml": { content: "a: 2\n" } },
    });

    expect(lost.code).not.toBe(0);
    expect(lost.stderr).toMatch(/connection reset/);
    expect((await gh.gist(gist.id)).files["a.yaml"]?.content).toBe("a: 2\n");
  });

  it("refuses hostnames other than github.com", async () => {
    const { call } = await setup();
    const result = await call(["api", "user", "--hostname", "ghe.example.com"]);
    expect(result.code).not.toBe(0);
  });
});
